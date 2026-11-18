import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { days } from "../harness/clock.js";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

describe("creating a Workspace", () => {
  test("any User can create a Workspace and becomes its Admin", async () => {
    const { workspace: first } = await setUp(cronk);
    const cookie = await signIn(cronk);

    const response = await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "  Friends  " } });

    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toEqual({ id: expect.any(String), name: "Friends", isAdmin: true });
    const me = await (await cronk.request("GET", "/api/me", { cookie })).json();
    expect(me.workspaces).toEqual([
      { id: first.id, name: "Ada's Workspace", isAdmin: true },
      { id: created.id, name: "Friends", isAdmin: true },
    ]);
    const shown = await cronk.request("GET", `/api/workspaces/${created.id}`, { cookie });
    expect(await shown.json()).toEqual({ id: created.id, name: "Friends" });
  });

  test("a Workspace needs a name, and a User signed in", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    expect((await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "   " } })).status).toBe(400);
    expect((await cronk.request("POST", "/api/workspaces", { body: { name: "Friends" } })).status).toBe(401);
  });
});

/** The one-time secret in a link Cronk hands out, which the web client reads from the URL's fragment. */
const tokenOf = (url: string) => new URL(url).hash.slice(1);

describe("adding Users by email", () => {
  test("an Admin adds someone by email and gets a one-time link; using it sets a password and joins", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);

    const added = await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, {
      cookie,
      body: { email: "bea@example.com" },
    });

    expect(added.status).toBe(201);
    const { user, link } = await added.json();
    expect(user).toEqual({ id: expect.any(String), email: "bea@example.com", githubLogin: null });
    expect(link.url).toMatch(new RegExp(`^${cronk.url}/link#cronk_join_[A-Za-z0-9_-]{20,}$`));
    expect(link.expiresAt).toBe("2026-01-08T09:00:00.000Z");
    const token = tokenOf(link.url);

    // Until the link is used, the new User can't sign in.
    const early = await cronk.request("POST", "/api/sign-in", { body: { email: "bea@example.com", password: "x" } });
    expect(early.status).toBe(401);

    const shown = await cronk.request("POST", "/api/links/lookup", { body: { token } });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({
      kind: "join",
      email: "bea@example.com",
      workspace: { id: workspace.id, name: "Ada's Workspace" },
      setsPassword: true,
      signInWithGitHub: false,
    });

    const used = await cronk.request("POST", "/api/links/use", { body: { token, password: "bea's long password" } });
    expect(used.status).toBe(200);
    expect(await used.json()).toEqual({ user });

    const beaCookie = await signIn(cronk, "bea@example.com", "bea's long password");
    const me = await (await cronk.request("GET", "/api/me", { cookie: beaCookie })).json();
    expect(me.workspaces).toEqual([{ id: workspace.id, name: "Ada's Workspace", isAdmin: false }]);

    const members = await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie: beaCookie });
    expect(await members.json()).toEqual([
      { user: { id: expect.any(String), email: "ada@example.com", githubLogin: null }, isAdmin: true },
      { user, isAdmin: false },
    ]);
  });

  test("a link works once", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const { link } = await (
      await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email: "bea@example.com" } })
    ).json();
    const token = tokenOf(link.url);
    await cronk.request("POST", "/api/links/use", { body: { token, password: "bea's long password" } });

    for (const path of ["/api/links/lookup", "/api/links/use"]) {
      const again = await cronk.request("POST", path, { body: { token, password: "mallory's password" } });
      expect(again.status).toBe(404);
      expect(await again.json()).toEqual({ error: { code: "invalid_link", message: expect.any(String) } });
    }
    expect((await cronk.request("POST", "/api/sign-in", { body: { email: "bea@example.com", password: "mallory's password" } })).status).toBe(401);
  });

  test("a link is valid for 7 days", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const add = async (email: string) =>
      tokenOf(
        (await (await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email } })).json())
          .link.url,
      );
    const bea = await add("bea@example.com");
    const cy = await add("cy@example.com");

    cronk.clock.advance(days(7) - 1000);
    expect((await cronk.request("POST", "/api/links/use", { body: { token: bea, password: "bea's long password" } })).status).toBe(200);

    cronk.clock.advance(1000);
    const late = await cronk.request("POST", "/api/links/use", { body: { token: cy, password: "cy's long password" } });
    expect(late.status).toBe(404);
    expect(await late.json()).toEqual({ error: { code: "invalid_link", message: expect.any(String) } });
  });

  test("someone who can already sign in gets a link too, and joins by giving their own password", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const friends = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } })).json();
    const bea = await addMember(cronk, cookie, friends.id, "bea@example.com");

    const added = await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, {
      cookie,
      body: { email: "BEA@example.com" },
    });
    expect(added.status).toBe(201);
    const { user, link } = await added.json();
    expect(user).toEqual(bea.user);
    const token = tokenOf(link.url);
    // Nothing joins them until they use the link.
    expect((await cronk.request("GET", `/api/workspaces/${workspace.id}`, { cookie: bea.cookie })).status).toBe(404);
    expect(await (await cronk.request("POST", "/api/links/lookup", { body: { token } })).json()).toEqual({
      kind: "join",
      email: "bea@example.com",
      workspace: { id: workspace.id, name: "Ada's Workspace" },
      setsPassword: false,
      signInWithGitHub: false,
    });

    const wrong = await cronk.request("POST", "/api/links/use", { body: { token, password: "not bea's password" } });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: { code: "wrong_password", message: expect.any(String) } });

    const used = await cronk.request("POST", "/api/links/use", { body: { token, password: bea.password } });
    expect(used.status).toBe(200);
    const me = await (await cronk.request("GET", "/api/me", { cookie: bea.cookie })).json();
    expect(me.workspaces.map((w: { name: string }) => w.name)).toEqual(["Ada's Workspace", "Friends"]);
    await signIn(cronk, "bea@example.com", bea.password);

    const twice = await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, {
      cookie,
      body: { email: "bea@example.com" },
    });
    expect(twice.status).toBe(409);
    expect(await twice.json()).toEqual({ error: { code: "already_member", message: expect.any(String) } });
  });

  test("a link needs a real password", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const { link } = await (
      await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email: "bea@example.com" } })
    ).json();

    const short = await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(link.url), password: "short" } });
    expect(short.status).toBe(400);
    const none = await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(link.url) } });
    expect(none.status).toBe(400);
  });
});

describe("Admins", () => {
  test("an Admin can make another member Admin, and take it away", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const path = `/api/workspaces/${workspace.id}/members/${bea.user.id}`;

    const made = await cronk.request("PATCH", path, { cookie, body: { isAdmin: true } });
    expect(made.status).toBe(200);
    expect(await made.json()).toEqual({ user: bea.user, isAdmin: true });
    const asBea = await (await cronk.request("GET", "/api/me", { cookie: bea.cookie })).json();
    expect(asBea.workspaces).toEqual([{ id: workspace.id, name: "Ada's Workspace", isAdmin: true }]);

    const unmade = await cronk.request("PATCH", path, { cookie, body: { isAdmin: false } });
    expect(await unmade.json()).toEqual({ user: bea.user, isAdmin: false });
    const members = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    expect(members.map((m: { isAdmin: boolean }) => m.isAdmin)).toEqual([true, false]);
  });

  test("a Workspace can't be left without an Admin", async () => {
    const { user: ada, workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const adaPath = `/api/workspaces/${workspace.id}/members/${ada.id}`;

    for (const [method, body] of [
      ["PATCH", { isAdmin: false }],
      ["DELETE", undefined],
    ] as const) {
      const refused = await cronk.request(method, adaPath, { cookie, body });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ error: { code: "last_admin", message: expect.any(String) } });
    }

    // With another Admin, the first may step down.
    await cronk.request("PATCH", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, { cookie, body: { isAdmin: true } });
    expect((await cronk.request("PATCH", adaPath, { cookie, body: { isAdmin: false } })).status).toBe(200);
    const left = await cronk.request("PATCH", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, {
      cookie: bea.cookie,
      body: { isAdmin: false },
    });
    expect(left.status).toBe(409);
  });
});

describe("removing members", () => {
  test("an Admin removes a member, who then gets 404 for that Workspace", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const other = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } })).json();
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const { link } = await (
      await cronk.request("POST", `/api/workspaces/${other.id}/members`, { cookie, body: { email: "bea@example.com" } })
    ).json();
    await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(link.url), password: bea.password } });

    const removed = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, { cookie });

    expect(removed.status).toBe(204);
    for (const path of [`/api/workspaces/${workspace.id}`, `/api/workspaces/${workspace.id}/members`]) {
      const response = await cronk.request("GET", path, { cookie: bea.cookie });
      expect(response.status).toBe(404);
    }
    const me = await (await cronk.request("GET", "/api/me", { cookie: bea.cookie })).json();
    expect(me.workspaces).toEqual([{ id: other.id, name: "Friends", isAdmin: false }]);
    const members = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    expect(members.map((m: { user: { email: string } }) => m.user.email)).toEqual(["ada@example.com"]);

    const again = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, { cookie });
    expect(again.status).toBe(404);
  });

  test("a removed member can be added again", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, { cookie });

    const again = await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email: "bea@example.com" } });
    const { user, link } = await again.json();
    expect(user).toEqual(bea.user);
    await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(link.url), password: bea.password } });
    expect((await cronk.request("GET", `/api/workspaces/${workspace.id}`, { cookie: bea.cookie })).status).toBe(200);
  });

  test("a removed member can't rejoin through an unused link", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const add = () => cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email: "bea@example.com" } });
    const first = await (await add()).json();
    const second = await (await add()).json();
    await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(first.link.url), password: "bea's long password" } });
    await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${first.user.id}`, { cookie });

    const rejoin = await cronk.request("POST", "/api/links/use", {
      body: { token: tokenOf(second.link.url), password: "bea's long password" },
    });
    expect(rejoin.status).toBe(404);
  });
});

describe("pending adds", () => {
  test("an Admin sees who they added by email but who hasn't joined yet, apart from the members", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const add = async (email: string) =>
      (await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email } })).json();
    const bea = await add("bea@example.com");
    cronk.clock.advance(1000);
    const cy = await add("cy@example.com");
    await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(cy.link.url), password: "cy's long password" } });

    const pending = await cronk.request("GET", `/api/workspaces/${workspace.id}/pending-adds`, { cookie });

    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual([
      { user: bea.user, addedVia: "email", addedAt: "2026-01-01T09:00:00.000Z", expiresAt: "2026-01-08T09:00:00.000Z" },
    ]);
    const members = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    expect(members.map((m: { user: { email: string } }) => m.user.email)).toEqual(["ada@example.com", "cy@example.com"]);
  });

  test("an add by email stops being pending once its link expires", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email: "bea@example.com" } });

    cronk.clock.advance(days(7));

    expect(await (await cronk.request("GET", `/api/workspaces/${workspace.id}/pending-adds`, { cookie })).json()).toEqual([]);
  });

  test("an Admin cancels an add by email; its links stop working and nobody joins", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const add = async () =>
      (await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email: "bea@example.com" } })).json();
    const first = await add();
    const second = await add();

    const cancelled = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/pending-adds/${first.user.id}`, { cookie });

    expect(cancelled.status).toBe(204);
    expect(await (await cronk.request("GET", `/api/workspaces/${workspace.id}/pending-adds`, { cookie })).json()).toEqual([]);
    for (const { link } of [first, second]) {
      const used = await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(link.url), password: "bea's long password" } });
      expect(used.status).toBe(404);
      expect(await used.json()).toEqual({ error: { code: "invalid_link", message: expect.any(String) } });
    }
    expect((await cronk.request("POST", "/api/sign-in", { body: { email: "bea@example.com", password: "bea's long password" } })).status).toBe(401);
    const again = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/pending-adds/${first.user.id}`, { cookie });
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
  });

  test("cancelling an add leaves the User's other Workspaces alone, and they can be added again", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const friends = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } })).json();
    const add = async (workspaceId: string) =>
      (await cronk.request("POST", `/api/workspaces/${workspaceId}/members`, { cookie, body: { email: "bea@example.com" } })).json();
    const here = await add(workspace.id);
    const there = await add(friends.id);

    await cronk.request("DELETE", `/api/workspaces/${workspace.id}/pending-adds/${here.user.id}`, { cookie });

    const used = await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(there.link.url), password: "bea's long password" } });
    expect(used.status).toBe(200);
    const again = await add(workspace.id);
    expect((await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(again.link.url), password: "bea's long password" } })).status).toBe(200);
    const beaCookie = await signIn(cronk, "bea@example.com", "bea's long password");
    const me = await (await cronk.request("GET", "/api/me", { cookie: beaCookie })).json();
    expect(me.workspaces.map((w: { name: string }) => w.name).sort()).toEqual(["Ada's Workspace", "Friends"]);
  });

  test("a member is not a pending add, so cancelling refuses them", async () => {
    const { user: ada, workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);

    const response = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/pending-adds/${ada.id}`, { cookie });

    expect(response.status).toBe(404);
    const members = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    expect(members).toEqual([{ user: ada, isAdmin: true }]);
  });
});

describe("renaming", () => {
  test("an Admin renames the Workspace", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);

    const renamed = await cronk.request("PATCH", `/api/workspaces/${workspace.id}`, { cookie, body: { name: " Home " } });

    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id: workspace.id, name: "Home" });
    const me = await (await cronk.request("GET", "/api/me", { cookie })).json();
    expect(me.workspaces).toEqual([{ id: workspace.id, name: "Home", isAdmin: true }]);
    expect((await cronk.request("PATCH", `/api/workspaces/${workspace.id}`, { cookie, body: { name: "" } })).status).toBe(400);
  });
});

describe("who may do what", () => {
  test("non-Admins are refused every Admin action", async () => {
    const { user: ada, workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const base = `/api/workspaces/${workspace.id}`;
    const cy = await (await cronk.request("POST", `${base}/members`, { cookie, body: { email: "cy@example.com" } })).json();

    for (const [method, path, body] of [
      ["PATCH", base, { name: "Bea's now" }],
      ["POST", `${base}/members`, { email: "cy@example.com" }],
      ["PATCH", `${base}/members/${bea.user.id}`, { isAdmin: true }],
      ["PATCH", `${base}/members/${ada.id}`, { isAdmin: false }],
      ["DELETE", `${base}/members/${ada.id}`, undefined],
      ["POST", `${base}/members/${ada.id}/reset-link`, undefined],
      ["GET", `${base}/pending-adds`, undefined],
      ["DELETE", `${base}/pending-adds/${cy.user.id}`, undefined],
    ] as const) {
      const response = await cronk.request(method, path, { cookie: bea.cookie, body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "not_admin", message: expect.any(String) } });
    }
    const members = await (await cronk.request("GET", `${base}/members`, { cookie })).json();
    expect(members).toEqual([
      { user: ada, isAdmin: true },
      { user: bea.user, isAdmin: false },
    ]);
    expect(await (await cronk.request("GET", base, { cookie })).json()).toEqual({ id: workspace.id, name: "Ada's Workspace" });
    const pending = await (await cronk.request("GET", `${base}/pending-adds`, { cookie })).json();
    expect(pending.map((p: { user: { id: string } }) => p.user.id)).toEqual([cy.user.id]);
  });

  test("anything in a Workspace the caller doesn't belong to answers 404", async () => {
    const { user: ada, workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const outsider = await (async () => {
      const friends = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } })).json();
      return addMember(cronk, cookie, friends.id, "eve@example.com");
    })();
    const base = `/api/workspaces/${workspace.id}`;

    for (const [method, path, body] of [
      ["GET", base, undefined],
      ["PATCH", base, { name: "Eve's now" }],
      ["GET", `${base}/members`, undefined],
      ["POST", `${base}/members`, { email: "cy@example.com" }],
      ["PATCH", `${base}/members/${ada.id}`, { isAdmin: false }],
      ["DELETE", `${base}/members/${ada.id}`, undefined],
      ["POST", `${base}/members/${ada.id}/reset-link`, undefined],
      ["GET", `${base}/pending-adds`, undefined],
      ["DELETE", `${base}/pending-adds/${ada.id}`, undefined],
      ["GET", "/api/workspaces/not-a-uuid/members", undefined],
      ["DELETE", `${base}/pending-adds/not-a-uuid`, undefined],
      ["DELETE", `${base}/members/not-a-uuid`, undefined],
    ] as const) {
      const response = await cronk.request(method, path, { cookie: outsider.cookie, body });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    }
  });
});

describe("passwords", () => {
  test("an Admin issues a reset link for a member; using it sets a new password and ends their sign-ins", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");

    const issued = await cronk.request("POST", `/api/workspaces/${workspace.id}/members/${bea.user.id}/reset-link`, { cookie });

    expect(issued.status).toBe(201);
    const link = await issued.json();
    expect(link).toEqual({
      url: expect.stringMatching(new RegExp(`^${cronk.url}/link#cronk_reset_[A-Za-z0-9_-]{20,}$`)),
      expiresAt: "2026-01-08T09:00:00.000Z",
    });
    const token = tokenOf(link.url);
    expect(await (await cronk.request("POST", "/api/links/lookup", { body: { token } })).json()).toEqual({
      kind: "reset",
      email: "bea@example.com",
      workspace: { id: workspace.id, name: "Ada's Workspace" },
      setsPassword: true,
      signInWithGitHub: false,
    });
    // Issuing a link changes nothing until it is used.
    expect((await cronk.request("GET", "/api/me", { cookie: bea.cookie })).status).toBe(200);

    const used = await cronk.request("POST", "/api/links/use", { body: { token, password: "bea's new password" } });

    expect(used.status).toBe(200);
    expect((await cronk.request("GET", "/api/me", { cookie: bea.cookie })).status).toBe(401);
    expect((await cronk.request("POST", "/api/sign-in", { body: { email: "bea@example.com", password: bea.password } })).status).toBe(401);
    await signIn(cronk, "bea@example.com", "bea's new password");
    expect((await cronk.request("POST", "/api/links/use", { body: { token, password: "another password" } })).status).toBe(404);
  });

  test("an Admin can't issue reset links for Users outside the Workspace", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const friends = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } })).json();
    const eve = await addMember(cronk, cookie, friends.id, "eve@example.com");

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/members/${eve.user.id}/reset-link`, { cookie });
    expect(response.status).toBe(404);
  });

  test("an Admin can't issue reset links for a member who also belongs to Workspaces they aren't Admin of", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    await cronk.request("POST", "/api/workspaces", { cookie: bea.cookie, body: { name: "Bea's own" } });

    const refused = await cronk.request("POST", `/api/workspaces/${workspace.id}/members/${bea.user.id}/reset-link`, { cookie });

    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: { code: "member_elsewhere", message: expect.any(String) } });
  });

  test("an Admin's reset link ends once its member is out of the Admin's reach", async () => {
    const { user: ada, workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const issue = async (userId: string) =>
      tokenOf(
        (await (await cronk.request("POST", `/api/workspaces/${workspace.id}/members/${userId}/reset-link`, { cookie })).json()).url,
      );
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const cy = await addMember(cronk, cookie, workspace.id, "cy@example.com");
    const dee = await addMember(cronk, cookie, workspace.id, "dee@example.com");
    const forBea = await issue(bea.user.id);
    const forCy = await issue(cy.user.id);
    const forDee = await issue(dee.user.id);

    // Bea starts a Workspace of her own; Cy is removed; Dee becomes Admin and takes Admin from Ada.
    await cronk.request("POST", "/api/workspaces", { cookie: bea.cookie, body: { name: "Bea's own" } });
    await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${cy.user.id}`, { cookie });
    await cronk.request("PATCH", `/api/workspaces/${workspace.id}/members/${dee.user.id}`, { cookie, body: { isAdmin: true } });
    await cronk.request("PATCH", `/api/workspaces/${workspace.id}/members/${ada.id}`, { cookie: dee.cookie, body: { isAdmin: false } });

    for (const token of [forBea, forCy, forDee]) {
      const used = await cronk.request("POST", "/api/links/use", { body: { token, password: "taken over at last" } });
      expect(used.status).toBe(404);
    }
  });
});
