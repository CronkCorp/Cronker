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

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_block",
      "comment",
      "compare_versions",
      "create_document",
      "create_sub_ticket",
      "edit_document",
      "edit_ticket",
      "file_ticket",
      "finish",
      "link_document",
      "list_document_versions",
      "list_documents",
      "list_tickets",
      "read_document",
      "read_ticket",
      "unlink_document",
      "write_report",
    ]);
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

  test("an Agent reads a Ticket with its Linked Documents", async () => {
    const { cookie, ticket, secret } = await workspaceWithTicket();
    const document = await post(cookie, `/api/projects/${ticket.projectId}/documents`, { title: "Sign-in design" });
    await post(cookie, `/api/tickets/${ticket.id}/documents`, { documentId: document.id });
    const client = await connect(secret);

    const { json } = await call(client, "read_ticket", { ticket: "CRONK-1" });

    expect(json.linkedDocuments).toEqual([{ id: document.id, projectId: ticket.projectId, title: "Sign-in design" }]);
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

  test("an Agent finishes its Run with an Outcome, which moves its Ticket, and reads its Runs", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const project = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
      cookie,
      body: { delegateId: agent.id, statusId: status("Triage") },
    });
    const client = await connect(secret);
    const read = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(read.json.runs).toEqual([expect.objectContaining({ state: "running", step: { statusId: status("Triage"), name: "Triage" } })]);
    const runId = read.json.runs[0].id;

    const refused = await call(client, "finish", { run: runId, outcome: "approve" });
    expect(refused.isError).toBe(true);
    expect(refused.json).toEqual(expect.objectContaining({ code: "outcome_not_offered", advice: expect.stringContaining("ready") }));

    const { isError, json } = await call(client, "finish", { run: runId, outcome: "ready", report: "Clear." });

    expect(isError).toBe(false);
    expect(json).toEqual(expect.objectContaining({ id: runId, state: "finished", outcome: "ready" }));
    const moved = await (await cronk.request("GET", `/api/tickets/${ticket.id}`, { cookie })).json();
    expect(moved.statusId).toBe(status("Ready"));
    const after = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(after.json.reports).toEqual([expect.objectContaining({ runId, title: "Triage report", body: "Clear." })]);
  });

  test("during its Run an Agent edits its Ticket and writes Reports, which a later Run reads", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const project = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
      cookie,
      body: { delegateId: agent.id, statusId: status("Investigate") },
    });
    const client = await connect(secret);

    const edited = await call(client, "edit_ticket", {
      ticket: "CRONK-1",
      description: "Do it, carefully.",
      priority: "high",
      labels: ["parser"],
      dueDate: "2026-02-01",
      estimate: 2,
    });
    expect(edited.isError).toBe(false);
    expect(edited.json).toEqual(
      expect.objectContaining({ description: "Do it, carefully.", priority: "high", labels: ["parser"], dueDate: "2026-02-01", estimate: 2 }),
    );
    const cleared = await call(client, "edit_ticket", { ticket: "CRONK-1", dueDate: null });
    expect(cleared.json.dueDate).toBeNull();
    const refused = await call(client, "edit_ticket", { ticket: "CRONK-2", priority: "low" });
    expect(refused).toEqual({ isError: true, json: expect.objectContaining({ code: "no_running_run", advice: expect.any(String) }) });

    const written = await call(client, "write_report", { ticket: "CRONK-1", title: "Findings", body: "In the parser." });
    expect(written.isError).toBe(false);
    const { json: read } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    await call(client, "finish", { run: read.runs[0].id, outcome: "done" });

    // The next Run, of Implement, reads what the earlier one wrote.
    const later = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(later.json.runs.map((r: { step: { name: string } }) => r.step.name)).toEqual(["Investigate", "Implement"]);
    expect(later.json.reports).toEqual([
      expect.objectContaining({ runId: read.runs[0].id, title: "Findings", body: "In the parser." }),
    ]);
  });

  test("during its Run an Agent links and unlinks Documents on its Ticket", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const project = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: agent.id, statusId: status("Triage") } });
    const design = await post(cookie, `/api/projects/${project.id}/documents`, { title: "Sign-in design" });
    const client = await connect(secret);

    const linked = await call(client, "link_document", { ticket: "CRONK-1", document: design.id });
    expect(linked).toEqual({ isError: false, json: { id: design.id, projectId: project.id, title: "Sign-in design" } });
    const refused = await call(client, "link_document", { ticket: "CRONK-2", document: design.id });
    expect(refused).toEqual({ isError: true, json: expect.objectContaining({ code: "no_running_run" }) });

    const unlinked = await call(client, "unlink_document", { ticket: "CRONK-1", document: design.id });
    expect(unlinked.isError).toBe(false);
    const { json: read } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(read.linkedDocuments).toEqual([]);
  });

  test("during its Run an Agent splits its Ticket and files a Discovered Ticket that blocks it", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const project = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
      cookie,
      body: { delegateId: agent.id, statusId: status("Investigate") },
    });
    const client = await connect(secret);
    const { json: read } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    const runId = read.runs[0].id;

    const sub = await call(client, "create_sub_ticket", { ticket: "CRONK-1", title: "First half", description: "Half." });
    expect(sub.isError).toBe(false);
    expect(sub.json).toEqual(expect.objectContaining({ key: "CRONK-3", parentId: ticket.id, delegateId: agent.id }));

    const found = await call(client, "file_ticket", { project: "cronk", title: "Flaky parser", run: runId });
    expect(found.isError).toBe(false);
    expect(found.json).toEqual(
      expect.objectContaining({ key: "CRONK-4", delegateId: null, discovered: expect.objectContaining({ runId, waiting: true }) }),
    );
    const retitled = await call(client, "edit_ticket", { ticket: "CRONK-4", title: "Flaky parser on comments" });
    expect(retitled.json.title).toBe("Flaky parser on comments");

    const blocked = await call(client, "add_block", { ticket: "CRONK-4", blocks: "CRONK-1" });
    expect(blocked.isError).toBe(false);
    expect(blocked.json).toEqual(expect.objectContaining({ kind: "blocks", ticket: expect.objectContaining({ key: "CRONK-1" }) }));
    const refused = await call(client, "add_block", { ticket: "CRONK-2", blocks: "CRONK-1" });
    expect(refused).toEqual({ isError: true, json: expect.objectContaining({ code: "not_your_discovered_ticket" }) });
    const noProject = await call(client, "file_ticket", { project: "NOPE", title: "Lost" });
    expect(noProject).toEqual({ isError: true, json: expect.objectContaining({ code: "unknown_project", advice: expect.stringContaining("CRONK") }) });
  });

  test("an Agent creates, edits, moves and reads Documents in a Project's page tree and the Workspace's", async () => {
    const { cookie, agent, secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const guides = await call(client, "create_document", { project: "cronk", title: "Guides" });
    const setup = await call(client, "create_document", { project: "CRONK", title: "Setup", body: "Run it." });
    const handbook = await call(client, "create_document", { title: "Handbook" });
    expect([guides.isError, setup.isError, handbook.isError]).toEqual([false, false, false]);
    expect(handbook.json).toEqual(expect.objectContaining({ projectId: null, title: "Handbook" }));

    const saved = await call(client, "edit_document", {
      document: setup.json.id,
      baseVersion: 1,
      title: "Setting up",
      body: "Install it.\nRun it.",
    });
    expect(saved.json.version).toEqual(expect.objectContaining({ number: 2, actor: { kind: "agent", id: agent.id, name: "claude-max" } }));
    const moved = await call(client, "edit_document", { document: setup.json.id, parent: guides.json.id });
    expect(moved.json).toEqual(expect.objectContaining({ parentId: guides.json.id, position: 0 }));
    const outdated = await call(client, "edit_document", { document: setup.json.id, baseVersion: 1, body: "Stale." });
    expect(outdated.isError).toBe(true);
    expect(outdated.json).toEqual(
      expect.objectContaining({ code: "outdated_version", current: expect.objectContaining({ number: 2, body: "Install it.\nRun it." }) }),
    );

    const projectTree = await call(client, "list_documents", { project: "cronk" });
    expect(projectTree.json.map((d: { title: string; parentId: string | null }) => [d.title, d.parentId])).toEqual([
      ["Guides", null],
      ["Setting up", guides.json.id],
    ]);
    const workspaceTree = await call(client, "list_documents", {});
    expect(workspaceTree.json.map((d: { title: string }) => d.title)).toEqual(["Handbook"]);
    const current = await call(client, "read_document", { document: setup.json.id });
    expect(current.json).toEqual(expect.objectContaining({ title: "Setting up", body: "Install it.\nRun it." }));
    const first = await call(client, "read_document", { document: setup.json.id, version: 1 });
    expect(first.json).toEqual(expect.objectContaining({ number: 1, title: "Setup", body: "Run it." }));
    const versions = await call(client, "list_document_versions", { document: setup.json.id });
    expect(versions.json.map((v: { number: number }) => v.number)).toEqual([1, 2]);
    const compared = await call(client, "compare_versions", { document: setup.json.id, from: 1, to: 2 });
    expect(compared.json.lines).toEqual([
      { change: "added", text: "Install it." },
      { change: "same", text: "Run it." },
    ]);
    const read = await (await cronk.request("GET", `/api/documents/${setup.json.id}`, { cookie })).json();
    expect(read.title).toBe("Setting up");
  });

  test("a revoked token is refused at once, even on an open connection", async () => {
    const { cookie, agent, secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const [token] = await (await cronk.request("GET", `/api/agents/${agent.id}/tokens`, { cookie })).json();

    await cronk.request("DELETE", `/api/agents/${agent.id}/tokens/${token.id}`, { cookie });

    await expect(client.callTool({ name: "read_ticket", arguments: { ticket: "CRONK-1" } })).rejects.toThrow();
  });
});
