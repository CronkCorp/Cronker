import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Seam 4, kept thin: a real MCP client against the running server checks bearer tokens
 * and how the tools map onto the HTTP API. The rules themselves are tested at the API.
 */

let cronk: StartedCronk;
const clients: Client[] = [];
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await cronk?.stop();
});

async function post(cookie: string, path: string, body: unknown) {
  const response = await cronk.request("POST", path, { cookie, body });
  expect(response.status).toBe(201);
  return response.json();
}

/** Ada's Workspace with a Ticket CRONK-1 that has a Comment, and a token of her Agent. */
async function workspaceWithTicket(access: "full" | "read" = "full") {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = await post(cookie, `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Read me", description: "Do it." });
  const later = await post(cookie, `/api/projects/${project.id}/tickets`, { title: "Later" });
  await post(cookie, `/api/tickets/${ticket.id}/relations`, { kind: "blocks", ticketId: later.id });
  await post(cookie, `/api/tickets/${ticket.id}/comments`, { body: "First thoughts." });
  const agent = await post(cookie, `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  const { secret } = await post(cookie, `/api/agents/${agent.id}/tokens`, { name: "laptop", access });
  return { cookie, ticket, agent, secret };
}

async function connect(token: string) {
  const client = new Client({ name: "cronk-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", cronk.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** A tool's result as the JSON its text holds. */
async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: result.isError ?? false, json: JSON.parse(content!.text) };
}

describe("MCP with an Agent token", () => {
  test("the MCP server refuses a request without a valid token", async () => {
    await workspaceWithTicket();

    await expect(connect("cronk_agent_nonsense")).rejects.toThrow();
    const response = await cronk.request("POST", "/mcp", {
      body: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  test("an Agent lists its tools", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(["comment", "list_tickets", "read_ticket"]);
  });

  test("an Agent reads a Ticket by key with its Comments and Relations", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const { isError, json } = await call(client, "read_ticket", { ticket: "cronk-1" });

    expect(isError).toBe(false);
    expect(json.ticket).toEqual(expect.objectContaining({ key: "CRONK-1", title: "Read me", description: "Do it." }));
    expect(json.comments).toEqual([
      expect.objectContaining({ body: "First thoughts.", actor: expect.objectContaining({ name: "ada@example.com" }) }),
    ]);
    expect(json.relations.relations).toEqual([
      expect.objectContaining({ kind: "blocks", ticket: expect.objectContaining({ key: "CRONK-2" }) }),
    ]);
  });

  test("an Agent lists Tickets, narrowed by Project and Status", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const all = await call(client, "list_tickets", {});
    expect(all.json.map((t: { key: string }) => t.key)).toEqual(["CRONK-1", "CRONK-2"]);
    const backlog = await call(client, "list_tickets", { project: "cronk", status: "backlog" });
    expect(backlog.json.map((t: { key: string; status: string }) => [t.key, t.status])).toEqual([
      ["CRONK-1", "Backlog"],
      ["CRONK-2", "Backlog"],
    ]);
    const triage = await call(client, "list_tickets", { project: "CRONK", status: "Triage" });
    expect(triage.json).toEqual([]);
  });

  test("an Agent comments on a Ticket as itself", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const { isError, json } = await call(client, "comment", { ticket: "CRONK-1", body: "On it." });

    expect(isError).toBe(false);
    expect(json).toEqual(expect.objectContaining({ body: "On it.", actor: { kind: "agent", id: agent.id, name: "claude-max" } }));
    const comments = await (await cronk.request("GET", `/api/tickets/${ticket.id}/comments`, { cookie })).json();
    expect(comments.map((c: { body: string }) => c.body)).toEqual(["First thoughts.", "On it."]);
  });

  test("a refusal reaches the Agent with its code, rule and advice", async () => {
    const { secret } = await workspaceWithTicket("read");
    const client = await connect(secret);

    const { isError, json } = await call(client, "comment", { ticket: "CRONK-1", body: "On it." });

    expect(isError).toBe(true);
    expect(json).toEqual({
      code: "read_only_token",
      message: expect.any(String),
      rule: "A read-only token may only read.",
      advice: expect.stringContaining("ada@example.com"),
    });
  });

  test("a revoked token is refused at once, even on an open connection", async () => {
    const { cookie, agent, secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const [token] = await (await cronk.request("GET", `/api/agents/${agent.id}/tokens`, { cookie })).json();

    await cronk.request("DELETE", `/api/agents/${agent.id}/tokens/${token.id}`, { cookie });

    await expect(client.callTool({ name: "read_ticket", arguments: { ticket: "CRONK-1" } })).rejects.toThrow();
  });
});
