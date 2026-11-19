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

/** Ada's Workspace with a Project, a Ticket with a Comment, and Ada's Agent with a token of the given access. */
async function agentWithTicket(access: "full" | "read" = "full") {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Read me" });
  const comment = await post(cookie, `/api/tickets/${ticket.id}/comments`, { body: "Mind CRONK-1." });
  const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  const { secret } = await post(cookie, `/api/agents/${agent.id}/tokens`, { name: "laptop", access });
  return { workspace, cookie, project, ticket, comment, agent, headers: { authorization: `Bearer ${secret}` } };
}

async function post(cookie: string, path: string, body: unknown) {
  const response = await cronk.request("POST", path, { cookie, body });
  expect(response.status).toBe(201);
  return response.json();
}

describe("what an Agent reads", () => {
  test("an Agent reads its Workspace's Projects, Tickets and Comments", async () => {
    const { workspace, cookie, project, ticket, comment, headers } = await agentWithTicket();

    const asUser = async (path: string) => (await cronk.request("GET", path, { cookie })).json();
    for (const path of [
      `/api/workspaces/${workspace.id}`,
      `/api/workspaces/${workspace.id}/members`,
      `/api/workspaces/${workspace.id}/projects`,
      `/api/projects/${project.id}`,
      `/api/projects/${project.id}/tickets`,
      `/api/tickets/${ticket.id}`,
      `/api/tickets/${ticket.id}/comments`,
      `/api/tickets/${ticket.id}/timeline`,
      `/api/tickets/${ticket.id}/relations`,
      `/api/workspaces/${workspace.id}/agents`,
    ]) {
      const response = await cronk.request("GET", path, { headers });
      expect(response.status, path).toBe(200);
      expect(await response.json(), path).toEqual(await asUser(path));
    }
    const comments = await (await cronk.request("GET", `/api/tickets/${ticket.id}/comments`, { headers })).json();
    expect(comments).toEqual([comment]);
  });

  test("an Agent finds a Ticket of its Workspace by key, ignoring case", async () => {
    const { workspace, ticket, headers } = await agentWithTicket();

    const response = await cronk.request("GET", `/api/workspaces/${workspace.id}/tickets/cronk-1`, { headers });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expect.objectContaining({ id: ticket.id, key: "CRONK-1", title: "Read me" }));
    const missing = await cronk.request("GET", `/api/workspaces/${workspace.id}/tickets/CRONK-2`, { headers });
    expect(missing.status).toBe(404);
  });

  test("a read-only token reads too", async () => {
    const { ticket, headers } = await agentWithTicket("read");
    expect((await cronk.request("GET", `/api/tickets/${ticket.id}`, { headers })).status).toBe(200);
  });

  test("an Agent sees nothing of another Workspace, even its Owner's", async () => {
    const { cookie, headers } = await agentWithTicket();
    const friends = await post(cookie, "/api/workspaces", { name: "Friends" });
    const project = await post(cookie, `/api/workspaces/${friends.id}/projects`, { name: "Party", key: "PARTY" });
    const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Secret" });

    for (const path of [
      `/api/workspaces/${friends.id}`,
      `/api/workspaces/${friends.id}/members`,
      `/api/workspaces/${friends.id}/projects`,
      `/api/workspaces/${friends.id}/tickets/PARTY-1`,
      `/api/projects/${project.id}`,
      `/api/projects/${project.id}/tickets`,
      `/api/tickets/${ticket.id}`,
      `/api/tickets/${ticket.id}/comments`,
      `/api/tickets/${ticket.id}/timeline`,
      `/api/tickets/${ticket.id}/relations`,
    ]) {
      expect((await cronk.request("GET", path, { headers })).status, path).toBe(404);
    }
    const commented = await cronk.request("POST", `/api/tickets/${ticket.id}/comments`, { headers, body: { body: "Hi" } });
    expect(commented.status).toBe(404);
  });
});

describe("what an Agent may change", () => {
  test("an Agent comments on a Ticket of its Workspace, and replies, as itself", async () => {
    const { ticket, comment, agent, headers } = await agentWithTicket();

    const response = await cronk.request("POST", `/api/tickets/${ticket.id}/comments`, {
      headers,
      body: { body: "On it.", replyToId: comment.id },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: expect.any(String),
      ticketId: ticket.id,
      replyToId: comment.id,
      body: "On it.",
      actor: { kind: "agent", id: agent.id, name: "claude-max" },
      createdAt: expect.any(String),
      mentions: [],
      questionId: null,
    });
  });

  test("a removed Agent's Comments still name it", async () => {
    const { cookie, ticket, agent, headers } = await agentWithTicket();
    await cronk.request("POST", `/api/tickets/${ticket.id}/comments`, { headers, body: { body: "Done here." } });

    await cronk.request("DELETE", `/api/agents/${agent.id}`, { cookie });

    const comments = await (await cronk.request("GET", `/api/tickets/${ticket.id}/comments`, { cookie })).json();
    expect(comments[1].actor).toEqual({ kind: "agent", id: agent.id, name: "claude-max" });
  });

  test("a read-only token can't comment, and is told the rule and what it may do instead", async () => {
    const { ticket, headers } = await agentWithTicket("read");

    const response = await cronk.request("POST", `/api/tickets/${ticket.id}/comments`, { headers, body: { body: "Hi" } });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toEqual({
      code: "read_only_token",
      message: expect.any(String),
      rule: "A read-only token may only read.",
      advice: expect.stringContaining("ada@example.com"),
    });
  });

  test("everything else is refused, naming the rule and what the Agent may do instead", async () => {
    const { workspace, project, ticket, agent, headers } = await agentWithTicket();
    const backlog = project.statuses[0].id;

    const attempts: [string, string, unknown?][] = [
      ["GET", "/api/me"],
      ["POST", "/api/workspaces", { name: "Mine" }],
      ["PATCH", `/api/workspaces/${workspace.id}`, { name: "Mine" }],
      ["POST", `/api/workspaces/${workspace.id}/members`, { email: "eve@example.com" }],
      ["POST", `/api/workspaces/${workspace.id}/projects`, { name: "Mine", key: "MINE" }],
      ["POST", `/api/projects/${project.id}/statuses`, { name: "Mine", kind: "active" }],
      ["DELETE", `/api/projects/${project.id}/statuses/${backlog}`],
      ["POST", `/api/workspaces/${workspace.id}/agents`, { name: "mine" }],
      ["DELETE", `/api/agents/${agent.id}`],
      ["POST", `/api/agents/${agent.id}/tokens`, { name: "mine", access: "full" }],
    ];
    for (const [method, path, body] of attempts) {
      const response = await cronk.request(method, path, { headers, body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await response.json()).error, `${method} ${path}`).toEqual({
        code: "agent_not_allowed",
        message: expect.any(String),
        rule: "Agents may read their Workspace, comment on its Tickets, file Tickets, and create, save and move Documents; during their running Run on a Ticket they may also edit it, split it into Sub-Tickets, write Reports on it and finish the Run, and they edit and add blocks from a Discovered Ticket they filed until a User takes it up. Everything else needs a User.",
        advice: expect.stringContaining("ada@example.com"),
      });
    }
    const unchanged = await (await cronk.request("GET", `/api/tickets/${ticket.id}`, { headers })).json();
    expect(unchanged.title).toBe("Read me");
  });

  test("every refusal an Agent meets names the rule and what it may do instead", async () => {
    const { ticket, headers } = await agentWithTicket();

    const refusals = [
      await cronk.request("GET", "/api/tickets/00000000-0000-0000-0000-000000000000", { headers }),
      await cronk.request("GET", "/api/nothing-here", { headers }),
      await cronk.request("POST", `/api/tickets/${ticket.id}/comments`, { headers, body: { body: " " } }),
      await cronk.request("POST", `/api/tickets/${ticket.id}/comments`, {
        headers,
        body: { body: "Hi", replyToId: "00000000-0000-0000-0000-000000000000" },
      }),
    ];

    for (const response of refusals) {
      const { error } = await response.json();
      expect(error, error.code).toEqual({
        code: expect.any(String),
        message: expect.any(String),
        rule: expect.any(String),
        advice: expect.any(String),
      });
    }
    expect(refusals.map((r) => r.status)).toEqual([404, 404, 400, 400]);
  });

  test("an Agent of another member is refused the same way", async () => {
    const { workspace, cookie, ticket } = await agentWithTicket();
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const agent = await post(bea.cookie, `/api/workspaces/${workspace.id}/agents`, { name: "bea-bot" });
    const { secret } = await post(bea.cookie, `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });

    const response = await cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
      headers: { authorization: `Bearer ${secret}` },
      body: { title: "Mine" },
    });

    expect(response.status).toBe(403);
    expect((await response.json()).error).toEqual(
      expect.objectContaining({ code: "agent_field_not_allowed", advice: expect.stringContaining("bea@example.com") }),
    );
  });
});
