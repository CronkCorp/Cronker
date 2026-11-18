import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { days } from "../harness/clock.js";
import { setUp, signIn } from "../harness/flows.js";
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

describe("adding people by email", () => {
  test("an Admin adds someone by email and gets a one-time link; using it sets a password and joins", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);

    const added = await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, {
      cookie,
      body: { email: "bea@example.com" },
    });

    expect(added.status).toBe(201);
    const { user, link } = await added.json();
    expect(user).toEqual({ id: expect.any(String), email: "bea@example.com" });
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
      needsPassword: true,
    });

    const used = await cronk.request("POST", "/api/links/use", { body: { token, password: "bea's long password" } });
    expect(used.status).toBe(200);
    expect(await used.json()).toEqual({ user });

    const beaCookie = await signIn(cronk, "bea@example.com", "bea's long password");
    const me = await (await cronk.request("GET", "/api/me", { cookie: beaCookie })).json();
    expect(me.workspaces).toEqual([{ id: workspace.id, name: "Ada's Workspace", isAdmin: false }]);

    const members = await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie: beaCookie });
    expect(await members.json()).toEqual([
      { user: { id: expect.any(String), email: "ada@example.com" }, isAdmin: true },
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

  test("someone who can already sign in joins at once, without a link", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const other = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } })).json();

    const added = await cronk.request("POST", `/api/workspaces/${other.id}/members`, {
      cookie,
      body: { email: "bea@example.com" },
    });
    const { link } = await added.json();
    await cronk.request("POST", "/api/links/use", { body: { token: tokenOf(link.url), password: "bea's long password" } });
    const beaCookie = await signIn(cronk, "bea@example.com", "bea's long password");

    const again = await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, {
      cookie,
      body: { email: "BEA@example.com" },
    });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ user: { id: expect.any(String), email: "bea@example.com" }, link: null });
    const me = await (await cronk.request("GET", "/api/me", { cookie: beaCookie })).json();
    expect(me.workspaces.map((w: { name: string }) => w.name)).toEqual(["Ada's Workspace", "Friends"]);

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
    expect(await none.json()).toEqual({ error: { code: "password_needed", message: expect.any(String) } });
  });
});
