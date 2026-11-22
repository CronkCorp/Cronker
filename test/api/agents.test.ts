import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

async function createAgent(cookie: string, workspaceId: string, name: string) {
  const response = await cronk.request("POST", `/api/workspaces/${workspaceId}/agents`, { cookie, body: { name } });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

async function issueToken(cookie: string, agentId: string, access: "full" | "read" = "full", name = "laptop") {
  const response = await cronk.request("POST", `/api/agents/${agentId}/tokens`, { cookie, body: { name, access } });
  expect(response.status).toBe(201);
  return (await response.json()) as { token: { id: string }; secret: string };
}

const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe("Agents", () => {
  test("a User creates an Agent of their own in a Workspace", async () => {
    const { user, workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, {
      cookie,
      body: { name: "claude-max" },
    });

    expect(response.status).toBe(201);
    const agent = await response.json();
    expect(agent).toEqual({
      id: expect.any(String),
      workspaceId: workspace.id,
      name: "claude-max",
      owner: { id: user.id, email: "ada@example.com", githubLogin: null, displayName: null },
      runnerId: null,
      createdAt: expect.any(String),
    });
    const listed = await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, { cookie });
    expect(await listed.json()).toEqual([agent]);
  });

  test("an Agent's name is unique in its Workspace, ignoring case", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createAgent(cookie, workspace.id, "claude-max");

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, {
      cookie,
      body: { name: "Claude-Max" },
    });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("agent_name_taken");
  });

  test("an Owner renames and removes their Agent", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const agent = await createAgent(cookie, workspace.id, "claude-max");

    const renamed = await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { name: "laptop" } });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("laptop");

    const removed = await cronk.request("DELETE", `/api/agents/${agent.id}`, { cookie });
    expect(removed.status).toBe(204);
    const listed = await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, { cookie });
    expect(await listed.json()).toEqual([]);
    // Its name is free again.
    await createAgent(cookie, workspace.id, "laptop");
  });

  test("another member sees an Agent but can't rename or remove it", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const agent = await createAgent(ada, workspace.id, "claude-max");
    const bea = await addMember(cronk, ada, workspace.id, "bea@example.com");

    const listed = await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, { cookie: bea.cookie });
    expect((await listed.json()).map((a: { name: string }) => a.name)).toEqual(["claude-max"]);

    const renamed = await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie: bea.cookie, body: { name: "mine" } });
    expect(renamed.status).toBe(403);
    expect((await renamed.json()).error.code).toBe("not_owner");
    const removed = await cronk.request("DELETE", `/api/agents/${agent.id}`, { cookie: bea.cookie });
    expect(removed.status).toBe(403);
    expect((await (await cronk.request("GET", `/api/workspaces/${workspace.id}/agents`, { cookie: ada })).json())).toHaveLength(1);
  });

  test("an Agent of a Workspace one doesn't belong to doesn't exist for them", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const other = await cronk.request("POST", "/api/workspaces", { cookie: ada, body: { name: "Friends" } });
    const friends = await other.json();
    const agent = await createAgent(ada, friends.id, "claude-max");
    const bea = await addMember(cronk, ada, workspace.id, "bea@example.com");

    const renamed = await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie: bea.cookie, body: { name: "mine" } });
    expect(renamed.status).toBe(404);
    const listed = await cronk.request("GET", `/api/workspaces/${friends.id}/agents`, { cookie: bea.cookie });
    expect(listed.status).toBe(404);
  });
});

describe("Agent tokens", () => {
  test("an Owner issues a token, shown once, that acts as the Agent", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const agent = await createAgent(cookie, workspace.id, "claude-max");

    const response = await cronk.request("POST", `/api/agents/${agent.id}/tokens`, {
      cookie,
      body: { name: "laptop", access: "read" },
    });

    expect(response.status).toBe(201);
    const issued = await response.json();
    expect(issued).toEqual({
      token: { id: expect.any(String), name: "laptop", access: "read", createdAt: expect.any(String) },
      secret: expect.stringMatching(/^cronk_agent_/),
    });
    const listed = await cronk.request("GET", `/api/agents/${agent.id}/tokens`, { cookie });
    expect(await listed.json()).toEqual([issued.token]);

    const me = await cronk.request("GET", "/api/agent", { headers: bearer(issued.secret) });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      agent: expect.objectContaining({ id: agent.id, name: "claude-max" }),
      workspace: { id: workspace.id, name: "Ada's Workspace", slug: "adas-workspace" },
      access: "read",
    });
  });

  test("a revoked token is refused at once", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const agent = await createAgent(cookie, workspace.id, "claude-max");
    const { token, secret } = await issueToken(cookie, agent.id);
    const other = await issueToken(cookie, agent.id, "full", "cloud");

    const revoked = await cronk.request("DELETE", `/api/agents/${agent.id}/tokens/${token.id}`, { cookie });
    expect(revoked.status).toBe(204);

    const response = await cronk.request("GET", "/api/agent", { headers: bearer(secret) });
    expect(response.status).toBe(401);
    const { error } = await response.json();
    expect(error.code).toBe("invalid_token");
    expect(error.advice).toEqual(expect.any(String));
    expect((await cronk.request("GET", "/api/agent", { headers: bearer(other.secret) })).status).toBe(200);
  });

  test("a removed Agent's tokens are refused at once", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const agent = await createAgent(cookie, workspace.id, "claude-max");
    const { secret } = await issueToken(cookie, agent.id);

    await cronk.request("DELETE", `/api/agents/${agent.id}`, { cookie });

    expect((await cronk.request("GET", "/api/agent", { headers: bearer(secret) })).status).toBe(401);
  });

  test("an Agent's tokens are refused once its Owner leaves the Workspace", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const bea = await addMember(cronk, ada, workspace.id, "bea@example.com");
    const agent = await createAgent(bea.cookie, workspace.id, "bea-bot");
    const { secret } = await issueToken(bea.cookie, agent.id);

    await cronk.request("DELETE", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, { cookie: ada });

    expect((await cronk.request("GET", "/api/agent", { headers: bearer(secret) })).status).toBe(401);
  });

  test("a User's sign-in still works behind a proxy that sends its own Basic credentials", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    const response = await cronk.request("GET", "/api/me", { cookie, headers: { authorization: "Basic YWRhOnNlY3JldA==" } });

    expect(response.status).toBe(200);
  });

  test("an unknown token is refused", async () => {
    await setUp(cronk);
    const response = await cronk.request("GET", "/api/agent", { headers: bearer("cronk_agent_nonsense") });
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("invalid_token");
  });

  test("only an Agent's Owner sees, issues and revokes its tokens", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const agent = await createAgent(ada, workspace.id, "claude-max");
    const { token } = await issueToken(ada, agent.id);
    const bea = await addMember(cronk, ada, workspace.id, "bea@example.com");

    const paths = [
      ["GET", `/api/agents/${agent.id}/tokens`, undefined],
      ["POST", `/api/agents/${agent.id}/tokens`, { name: "mine", access: "full" }],
      ["DELETE", `/api/agents/${agent.id}/tokens/${token.id}`, undefined],
    ] as const;
    for (const [method, path, body] of paths) {
      const response = await cronk.request(method, path, { cookie: bea.cookie, body });
      expect(response.status).toBe(403);
    }
  });
});
