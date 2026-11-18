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
      owner: { id: user.id, email: "ada@example.com" },
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
