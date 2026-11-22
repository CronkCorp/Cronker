import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, firstUser, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

async function ok(method: string, path: string, cookie: string, body?: unknown) {
  const response = await cronk.request(method, path, { cookie, body });
  expect(response.status, `${method} ${path}: ${await response.clone().text()}`).toBeLessThan(300);
  return response.status === 204 ? null : response.json();
}

const rename = (cookie: string, displayName: string | null) => cronk.request("PATCH", "/api/me", { cookie, body: { displayName } });

describe("one's own display name", () => {
  test("is set, shown on the User, trimmed, and cleared by null or an empty one", async () => {
    const { user } = await setUp(cronk);
    const cookie = await signIn(cronk);
    expect((await ok("GET", "/api/me", cookie)).user).toEqual({ ...user, displayName: null });

    const set = await rename(cookie, "  Ada Lovelace ");
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ user: { ...user, displayName: "Ada Lovelace" } });
    expect((await ok("GET", "/api/me", cookie)).user.displayName).toBe("Ada Lovelace");

    expect((await (await rename(cookie, "   ")).json()).user.displayName).toBeNull();
    await rename(cookie, "Ada");
    expect((await (await rename(cookie, null)).json()).user.displayName).toBeNull();
    expect((await ok("GET", "/api/me", cookie)).user.displayName).toBeNull();
  });

  test("leaves sign-in by email as it was", async () => {
    await setUp(cronk);
    await rename(await signIn(cronk), "Ada Lovelace");

    await signIn(cronk, firstUser.email, firstUser.password);
    const byName = await cronk.request("POST", "/api/sign-in", { body: { email: "Ada Lovelace", password: firstUser.password } });
    expect(byName.status).toBe(401);
  });

  test("is refused when too long or holding line breaks, changing nothing, and needs a sign-in", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await rename(cookie, "Ada");

    const cases: [string, unknown, number, string][] = [
      ["too long", { displayName: "a".repeat(81) }, 400, "invalid_request"],
      ["a line break", { displayName: "Ada\nLovelace" }, 400, "invalid_display_name"],
      ["a tab", { displayName: "Ada\tLovelace" }, 400, "invalid_display_name"],
      ["missing", {}, 400, "invalid_request"],
    ];
    for (const [what, body, status, code] of cases) {
      const response = await cronk.request("PATCH", "/api/me", { cookie, body });
      expect(response.status, what).toBe(status);
      expect((await response.json()).error.code, what).toBe(code);
    }
    const signedOut = await cronk.request("PATCH", "/api/me", { body: { displayName: "Mallory" } });
    expect(signedOut.status).toBe(401);

    expect((await ok("GET", "/api/me", cookie)).user.displayName).toBe("Ada");
  });

  test("names the User wherever Cronk names them, and their email still adds them to a Workspace", async () => {
    const { user, workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Name me" });
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Hello" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { assigneeId: user.id });

    expect((await (await rename(ada, "Ada Lovelace")).json()).user.displayName).toBe("Ada Lovelace");

    const named = { kind: "user", id: user.id, name: "Ada Lovelace" };
    const comments = await ok("GET", `/api/tickets/${ticket.id}/comments`, ada);
    expect(comments.map((comment: { actor: unknown }) => comment.actor)).toEqual([named]);
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.find((entry: { field: string }) => entry.field === "created").actor).toEqual(named);
    // A Change keeps the name its User had when it was made.
    expect(timeline.find((entry: { field: string }) => entry.field === "assignee").to).toEqual({ id: user.id, name: user.email });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { assigneeId: null });
    const unassigned = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).filter((entry: { field: string }) => entry.field === "assignee");
    expect(unassigned.at(-1).from).toEqual({ id: user.id, name: "Ada Lovelace" });

    const members = await ok("GET", `/api/workspaces/${workspace.id}/members`, ada);
    expect(members.find((member: { user: { id: string } }) => member.user.id === user.id).user).toEqual({
      ...user,
      displayName: "Ada Lovelace",
    });
    const agents = await ok("GET", `/api/workspaces/${workspace.id}/agents`, ada);
    expect(agents.find((a: { id: string }) => a.id === agent.id).owner).toEqual({ ...user, displayName: "Ada Lovelace" });

    const bob = await addMember(cronk, ada, workspace.id, "bob@example.com");
    const document = await ok("POST", `/api/workspaces/${workspace.id}/documents`, bob.cookie, { title: "Notes", body: "" });
    await rename(bob.cookie, "Bob");
    const versions = await ok("GET", `/api/documents/${document.id}/versions`, ada);
    expect(versions.map((version: { actor: unknown }) => version.actor)).toEqual([{ kind: "user", id: bob.user.id, name: "Bob" }]);
  });
});

describe("the address of one's settings page", () => {
  test("is no Workspace's slug, so no Workspace's pages are under it", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    expect(await ok("POST", "/api/workspaces", cookie, { name: "Account" })).toMatchObject({ slug: "account-2" });
  });

  test("moves a Workspace that had it as its slug before to another", async () => {
    await cronk.stop();
    cronk = await startCronk({ migrateBefore: "0054_account_slug.sql" });
    const id = crypto.randomUUID();
    await cronk.stage("insert into workspaces (id, name, slug, created_at) values ($1, 'Account', 'account', now())", [id]);

    await cronk.upgrade();

    const { user } = await setUp(cronk);
    await cronk.stage("insert into memberships (workspace_id, user_id, created_at) values ($1, $2, now())", [id, user.id]);
    const me = await ok("GET", "/api/me", await signIn(cronk));
    expect(me.workspaces.find((w: { id: string }) => w.id === id).slug).toBe("account-2");
  });
});
