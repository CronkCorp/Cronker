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

/** The model ids Cronk ships for the default labels: the latest model of each family. */
const defaults = [
  { label: "haiku", modelId: "claude-haiku-5-5" },
  { label: "opus", modelId: "claude-opus-5-5" },
  { label: "sonnet", modelId: "claude-sonnet-5-5" },
];

const modelIds = (workspaceId: string) => `/api/workspaces/${workspaceId}/model-ids`;

/** An Agent of the signed-in User in the Workspace, as the headers of a request with a full-access token of its. */
async function agentOf(cookie: string, workspaceId: string) {
  const agent = await (await cronk.request("POST", `/api/workspaces/${workspaceId}/agents`, { cookie, body: { name: "claude-max" } })).json();
  const token = await (await cronk.request("POST", `/api/agents/${agent.id}/tokens`, { cookie, body: { name: "laptop", access: "full" } })).json();
  return { headers: { authorization: `Bearer ${token.secret}` } };
}

describe("reading the model ids", () => {
  test("a Workspace starts with the latest model of each family for haiku, sonnet and opus, read by any of its Users and Agents", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const bea = await addMember(cronk, ada, workspace.id, "bea@example.com");
    const asAgent = await agentOf(ada, workspace.id);

    for (const as of [{ cookie: ada }, { cookie: bea.cookie }, asAgent]) {
      const response = await cronk.request("GET", modelIds(workspace.id), as);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(defaults);
    }
  });

  test("Workspaces that existed before model ids start with the same defaults", async () => {
    await cronk.stop();
    cronk = await startCronk({ migrateBefore: "0043_model_ids.sql" });
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const created = await cronk.request("POST", "/api/workspaces", { cookie: ada, body: { name: "Friends" } });
    const friends = (await created.json()) as { id: string };

    await cronk.upgrade();

    for (const id of [workspace.id, friends.id]) {
      expect(await (await cronk.request("GET", modelIds(id), { cookie: ada })).json()).toEqual(defaults);
    }
  });

  test("only the Workspace's own Users read them", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const created = await cronk.request("POST", "/api/workspaces", { cookie: ada, body: { name: "Friends" } });
    const friends = (await created.json()) as { id: string };
    const bea = await addMember(cronk, ada, friends.id, "bea@example.com");

    expect((await cronk.request("GET", modelIds(workspace.id), { cookie: bea.cookie })).status).toBe(404);
    expect((await cronk.request("GET", modelIds(workspace.id))).status).toBe(401);
  });
});

describe("Admins changing the model ids", () => {
  test("an Admin adds a label, changes a label's model id and removes a label", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const bea = await addMember(cronk, ada, workspace.id, "bea@example.com");

    const added = await cronk.request("PUT", `${modelIds(workspace.id)}/fable`, { cookie: ada, body: { modelId: " claude-fable-5-2 " } });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ label: "fable", modelId: "claude-fable-5-2" });
    const changed = await cronk.request("PUT", `${modelIds(workspace.id)}/opus`, { cookie: ada, body: { modelId: "claude-opus-5" } });
    expect(await changed.json()).toEqual({ label: "opus", modelId: "claude-opus-5" });
    const removed = await cronk.request("DELETE", `${modelIds(workspace.id)}/haiku`, { cookie: ada });
    expect(removed.status).toBe(204);

    // Bea, who isn't Admin, reads what Ada changed.
    expect(await (await cronk.request("GET", modelIds(workspace.id), { cookie: bea.cookie })).json()).toEqual([
      { label: "fable", modelId: "claude-fable-5-2" },
      { label: "opus", modelId: "claude-opus-5" },
      { label: "sonnet", modelId: "claude-sonnet-5-5" },
    ]);
  });

  test("labels are matched ignoring case, keeping one entry per label", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);

    const changed = await cronk.request("PUT", `${modelIds(workspace.id)}/Opus`, { cookie: ada, body: { modelId: "claude-opus-5" } });
    expect(await changed.json()).toEqual({ label: "Opus", modelId: "claude-opus-5" });
    expect((await cronk.request("DELETE", `${modelIds(workspace.id)}/SONNET`, { cookie: ada })).status).toBe(204);

    expect(await (await cronk.request("GET", modelIds(workspace.id), { cookie: ada })).json()).toEqual([
      { label: "haiku", modelId: "claude-haiku-5-5" },
      { label: "Opus", modelId: "claude-opus-5" },
    ]);
  });

  test("removing a label the Workspace doesn't have is not found, and a blank label or model id is refused", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);

    expect((await cronk.request("DELETE", `${modelIds(workspace.id)}/fable`, { cookie: ada })).status).toBe(404);
    expect((await cronk.request("PUT", `${modelIds(workspace.id)}/fable`, { cookie: ada, body: { modelId: "  " } })).status).toBe(400);
    expect((await cronk.request("PUT", `${modelIds(workspace.id)}/%20`, { cookie: ada, body: { modelId: "claude-fable-5-2" } })).status).toBe(400);
    expect(await (await cronk.request("GET", modelIds(workspace.id), { cookie: ada })).json()).toEqual(defaults);
  });

  test("members who aren't Admin, and Agents, are refused, changing nothing", async () => {
    const { workspace } = await setUp(cronk);
    const ada = await signIn(cronk);
    const bea = await addMember(cronk, ada, workspace.id, "bea@example.com");
    const asAgent = await agentOf(ada, workspace.id);

    for (const as of [{ cookie: bea.cookie }, asAgent]) {
      const changed = await cronk.request("PUT", `${modelIds(workspace.id)}/opus`, { ...as, body: { modelId: "claude-opus-5" } });
      expect(changed.status).toBe(403);
      const removed = await cronk.request("DELETE", `${modelIds(workspace.id)}/opus`, as);
      expect(removed.status).toBe(403);
    }
    expect((await (await cronk.request("PUT", `${modelIds(workspace.id)}/opus`, { ...asAgent, body: { modelId: "x" } })).json()).error.code).toBe(
      "agent_not_allowed",
    );
    expect((await (await cronk.request("DELETE", `${modelIds(workspace.id)}/opus`, { cookie: bea.cookie })).json()).error.code).toBe("not_admin");
    expect(await (await cronk.request("GET", modelIds(workspace.id), { cookie: ada })).json()).toEqual(defaults);
  });
});
