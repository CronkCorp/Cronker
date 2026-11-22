import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Seam 5, kept thin: a real MCP client against the running server checks bearer tokens
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
  return { workspace, cookie, ticket, agent, secret };
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
      "add_status",
      "attach_file",
      "comment",
      "compare_decision_versions",
      "compare_term_versions",
      "compare_versions",
      "create_artifact",
      "create_document",
      "create_project",
      "create_sub_ticket",
      "create_term",
      "edit_decision",
      "edit_document",
      "edit_status",
      "edit_term",
      "edit_ticket",
      "export_knowledge",
      "file_ticket",
      "finish",
      "link_artifact",
      "link_document",
      "list_artifacts",
      "list_decision_versions",
      "list_decisions",
      "list_document_versions",
      "list_documents",
      "list_term_versions",
      "list_tickets",
      "merge_pull_request",
      "propose_decision",
      "read_artifact",
      "read_decision",
      "read_document",
      "read_glossary",
      "read_project",
      "read_section",
      "read_term",
      "read_ticket",
      "remove_status",
      "remove_step",
      "replace_section",
      "save_artifact",
      "search",
      "set_step",
      "unlink_artifact",
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

  test("an Agent reads a Ticket with its Pull Requests, their state and checks", async () => {
    const { cookie, ticket, secret } = await workspaceWithTicket();
    await createGitHubApp(cronk, cookie);
    const app = cronk.github.apps[0]!;
    const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
    const cronker = installation.repositories[0]!;
    await post(cookie, `/api/projects/${ticket.projectId}/repositories`, { id: cronker.id });
    const repository = { id: cronker.id, full_name: "cronkcorp/cronker" };
    await cronk.github.deliver(app, "pull_request", {
      action: "opened",
      installation: { id: installation.id },
      repository,
      pull_request: {
        id: 501,
        number: 7,
        title: "CRONK-1: read me",
        state: "open",
        draft: true,
        merged: false,
        html_url: "https://github.com/cronkcorp/cronker/pull/7",
        head: { ref: "cronk-1", sha: "c1" },
        updated_at: "2026-01-01T09:00:00Z",
      },
    });
    await cronk.github.deliver(app, "check_run", {
      action: "completed",
      installation: { id: installation.id },
      repository,
      check_run: { id: 10, name: "test", head_sha: "c1", status: "completed", conclusion: "failure", html_url: null },
    });
    const client = await connect(secret);

    const { json } = await call(client, "read_ticket", { ticket: "CRONK-1" });

    expect(json.pullRequests).toEqual([
      {
        id: 501,
        repository: "cronkcorp/cronker",
        number: 7,
        title: "CRONK-1: read me",
        branch: "cronk-1",
        url: "https://github.com/cronkcorp/cronker/pull/7",
        state: "draft",
        checks: [{ name: "test", state: "failed", url: null }],
        mergedBy: null,
        producingStep: null,
        reviewState: null,
        sentBack: null,
        conflict: null,
        manual: false,
      },
    ]);
  });

  test("an Agent lists Tickets, narrowed by Project and Status", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    // CRONK-1 blocks CRONK-2, and a blocked Ticket lists before the rest of its Status.
    const all = await call(client, "list_tickets", {});
    expect(all.json.map((t: { key: string }) => t.key)).toEqual(["CRONK-2", "CRONK-1"]);
    const backlog = await call(client, "list_tickets", { project: "cronk", status: "backlog" });
    expect(backlog.json.map((t: { key: string; status: string }) => [t.key, t.status])).toEqual([
      ["CRONK-2", "Backlog"],
      ["CRONK-1", "Backlog"],
    ]);
    const triage = await call(client, "list_tickets", { project: "CRONK", status: "Triage" });
    expect(triage.json).toEqual([]);
  });

  test("an Agent searches its Workspace, narrowed by a Project's key and kinds, as the API answers", async () => {
    const { cookie, ticket, secret } = await workspaceWithTicket();
    const { workspaceId } = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const term = await post(cookie, `/api/projects/${ticket.projectId}/terms`, { name: "Reading", definition: "Done.", avoid: [] });
    await post(cookie, `/api/workspaces/${workspaceId}/documents`, { title: "Reading list" });
    const artifact = await post(cookie, `/api/projects/${ticket.projectId}/artifacts`, {
      title: "Reading room",
      files: [{ path: "index.html", contentBase64: Buffer.from("<p>Hi</p>").toString("base64") }],
    });
    const client = await connect(secret);

    const all = await call(client, "search", { query: "read" });
    const narrowed = await call(client, "search", { query: "read", project: "cronk", kinds: ["ticket", "term", "artifact"] });
    const unknown = await call(client, "search", { query: "read", project: "NOPE" });
    const transcripts = await call(client, "search", { query: "read", kinds: ["transcript"] });

    const api = await cronk.request("GET", `/api/workspaces/${workspaceId}/search?q=read`, { cookie });
    expect(all.json).toEqual(await api.json());
    expect(narrowed.json.map((r: { kind: string; id: string }) => [r.kind, r.id]).sort()).toEqual(
      [["artifact", artifact.id], ["term", term.id], ["ticket", ticket.id]].sort(),
    );
    expect(unknown).toEqual({ isError: true, json: expect.objectContaining({ code: "unknown_project" }) });
    expect(transcripts).toEqual({ isError: false, json: [] });
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

  test("an Agent's Merge Run merges through merge_pull_request, which passes on Cronk's refusal", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    await cronk.request("PATCH", `/api/projects/${ticket.projectId}`, { cookie, body: { agentsMayMerge: true } });
    const project = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const merge = project.statuses.find((s: { name: string }) => s.name === "Merge").id;
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
      cookie,
      body: { delegateId: agent.id, autonomousDelegation: true, statusId: merge },
    });
    const client = await connect(secret);
    const [run] = (await call(client, "read_ticket", { ticket: "CRONK-1" })).json.runs;
    expect(run).toMatchObject({ state: "running", step: { name: "Merge" } });

    const { isError, json } = await call(client, "merge_pull_request", { run: run.id, pullRequest: 501 });

    expect(isError).toBe(true);
    expect(json).toEqual(
      expect.objectContaining({
        code: "pull_request_not_linked",
        message: "That Pull Request isn't linked to CRONK-1.",
        rule: "A Merge Run merges only a Pull Request linked to its own Ticket.",
      }),
    );
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
    // The Report is a Document on the Ticket, with Versions, read like any other.
    const document = await call(client, "read_document", { document: written.json.id });
    expect(document.json).toEqual(
      expect.objectContaining({ ticketId: ticket.id, title: "Findings", version: expect.objectContaining({ number: 1 }) }),
    );
    const { json: read } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    await call(client, "finish", { run: read.runs[0].id, outcome: "done" });

    // The next Run, of Implement, reads what the earlier one wrote.
    const later = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(later.json.runs.map((r: { step: { name: string } }) => r.step.name)).toEqual(["Investigate", "Implement"]);
    expect(later.json.reports).toEqual([
      expect.objectContaining({ runId: read.runs[0].id, title: "Findings", body: "In the parser." }),
    ]);
  });

  test("a value a Ticket route refuses is refused by its tool, before anything is written", async () => {
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
    const { json: before } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    const runId = before.runs[0].id;
    const tooLong = "x".repeat(301);

    const refusals: [string, Record<string, unknown>, RegExp][] = [
      // Length, and a title that is only spaces.
      ["file_ticket", { project: "CRONK", title: tooLong, run: runId }, /title/],
      ["file_ticket", { project: "CRONK", title: "   " }, /title/],
      ["create_sub_ticket", { ticket: "CRONK-1", title: tooLong }, /title/],
      ["edit_ticket", { ticket: "CRONK-1", title: tooLong }, /title/],
      ["edit_ticket", { ticket: "CRONK-1", labels: ["x".repeat(51)] }, /labels/],
      ["comment", { ticket: "CRONK-1", body: " " }, /body/],
      ["write_report", { ticket: "CRONK-1", title: tooLong, body: "Findings." }, /title/],
      // Minimum.
      ["edit_ticket", { ticket: "CRONK-1", estimate: -1 }, /estimate/],
      // Enum.
      ["edit_ticket", { ticket: "CRONK-1", priority: "huge" }, /priority/],
      // Format.
      ["edit_ticket", { ticket: "CRONK-1", dueDate: "tomorrow" }, /dueDate/],
    ];
    for (const [tool, args, field] of refusals) {
      const result = await client.callTool({ name: tool, arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      expect({ tool, args, isError: result.isError }).toEqual({ tool, args, isError: true });
      expect(content!.text).toMatch(/validation/i);
      expect(content!.text).toMatch(field);
    }

    // Nothing was written: no Ticket, Comment, Report or Change.
    const { json: after } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(after.ticket).toEqual(before.ticket);
    expect(after.comments).toEqual(before.comments);
    expect(after.reports).toEqual([]);
    expect(after.relations.subTickets).toEqual([]);
    const tickets = await (await cronk.request("GET", `/api/projects/${ticket.projectId}/tickets`, { cookie })).json();
    expect(tickets.map((t: { key: string }) => t.key)).toEqual(expect.arrayContaining(["CRONK-1", "CRONK-2"]));
    expect(tickets).toHaveLength(2);
    const timeline = await (await cronk.request("GET", `/api/tickets/${ticket.id}/timeline`, { cookie })).json();
    const changesBefore = timeline.length;
    // The same edit, within the limits, goes through, and Agents still name their Ticket by its key.
    const accepted = await call(client, "edit_ticket", { ticket: "cronk-1", estimate: 0, priority: "low", dueDate: "2026-12-01" });
    expect(accepted.isError).toBe(false);
    const later = await (await cronk.request("GET", `/api/tickets/${ticket.id}/timeline`, { cookie })).json();
    expect(later.length).toBeGreaterThan(changesBefore);
  });

  test("the Ticket tools' inputs carry the routes' field descriptions and limits", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const { tools } = await client.listTools();
    const input = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };

    const edit = input("edit_ticket");
    // The Agent is offered only the fields it may edit, and names its Ticket its own way.
    expect(Object.keys(edit.properties).sort()).toEqual(
      ["description", "dueDate", "estimate", "labels", "priority", "ticket", "title"],
    );
    expect(edit.required).toEqual(["ticket"]);
    expect(edit.properties.title).toEqual(
      expect.objectContaining({ maxLength: 300, description: expect.stringContaining("Discovered Ticket") }),
    );
    expect(edit.properties.labels).toEqual(expect.objectContaining({ maxItems: 50 }));
    expect(JSON.stringify(edit.properties.dueDate)).toContain("2026-02-01");
    expect(JSON.stringify(edit.properties.estimate)).toContain('"minimum":0');
    expect(JSON.stringify(edit.properties.priority)).toContain("urgent");

    const filing = input("file_ticket");
    expect(Object.keys(filing.properties).sort()).toEqual(["description", "project", "run", "title"]);
    expect(filing.properties.title).toEqual(expect.objectContaining({ maxLength: 300, pattern: "\\S" }));
    expect(filing.properties.description).toEqual(expect.objectContaining({ maxLength: 100_000, description: "Markdown." }));
    expect(Object.keys(input("create_sub_ticket").properties).sort()).toEqual(["description", "ticket", "title"]);
    expect(input("comment").properties.body).toEqual(expect.objectContaining({ maxLength: 100_000 }));
    expect(input("write_report").properties.title).toEqual(
      expect.objectContaining({ maxLength: 300, description: "A short title, such as `Findings`." }),
    );
    expect(input("write_report").properties.body).toEqual(expect.objectContaining({ maxLength: 500_000 }));
  });

  test("a value a knowledge route refuses is refused by its tool, before anything is written", async () => {
    const { cookie, secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const base64 = (text: string) => Buffer.from(text).toString("base64");
    const document = (await call(client, "create_document", { project: "CRONK", title: "Setup", body: "# Setup\n" })).json;
    const term = (await call(client, "create_term", { project: "CRONK", name: "Ticket" })).json;
    const decision = (await call(client, "propose_decision", { project: "CRONK", title: "Use Postgres" })).json;
    const artifact = (
      await call(client, "create_artifact", { title: "Board", files: [{ path: "index.html", contentBase64: base64("<p>") }] })
    ).json;
    const read = async () => ({
      documents: await (await cronk.request("GET", `/api/projects/${document.projectId}/documents`, { cookie })).json(),
      document: await (await cronk.request("GET", `/api/documents/${document.id}`, { cookie })).json(),
      terms: await (await cronk.request("GET", `/api/projects/${document.projectId}/terms`, { cookie })).json(),
      decisions: await (await cronk.request("GET", `/api/projects/${document.projectId}/decisions`, { cookie })).json(),
      artifacts: await (await cronk.request("GET", `/api/workspaces/${artifact.workspaceId}/artifacts`, { cookie })).json(),
      attachments: await (await cronk.request("GET", `/api/documents/${document.id}/attachments`, { cookie })).json(),
    });
    const before = await read();
    const tooLong = "x".repeat(301);

    const refusals: [string, Record<string, unknown>, RegExp][] = [
      // Length.
      ["create_document", { project: "CRONK", title: tooLong }, /title/],
      ["replace_section", { document: document.id, section: "x".repeat(1001), baseVersion: 1, body: "# Setup\n" }, /section/],
      ["edit_term", { term: term.id, baseVersion: 1, definition: "x".repeat(20_001) }, /definition/],
      ["edit_term", { term: term.id, baseVersion: 1, avoid: ["x".repeat(201)] }, /avoid/],
      ["propose_decision", { project: "CRONK", title: tooLong }, /title/],
      ["save_artifact", { artifact: artifact.id, baseVersion: 1, remove: [""] }, /remove/],
      ["attach_file", { document: document.id, name: "x".repeat(256), contentBase64: base64("x") }, /name/],
      // Not only spaces.
      ["create_term", { project: "CRONK", name: "   " }, /name/],
      ["attach_file", { document: document.id, name: " ", contentBase64: base64("x") }, /name/],
      // Minimum.
      ["edit_document", { document: document.id, baseVersion: 0, title: "Set up" }, /baseVersion/],
      ["edit_document", { document: document.id, position: -1 }, /position/],
      // Most items.
      ["create_term", { project: "CRONK", name: "Run", avoid: Array.from({ length: 51 }, (_, i) => `word ${i}`) }, /avoid/],
      // Shape, and a field the tool asks for up front.
      ["create_artifact", { title: "Board", files: [{ path: "index.html" }] }, /contentBase64/],
      ["save_artifact", { artifact: artifact.id, title: "Board 2" }, /baseVersion/],
      ["edit_decision", { decision: decision.id, title: "Use SQLite" }, /baseVersion/],
    ];
    for (const [tool, args, field] of refusals) {
      const result = await client.callTool({ name: tool, arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      expect({ tool, args, isError: result.isError }).toEqual({ tool, args, isError: true });
      expect(content!.text).toMatch(/validation/i);
      expect(content!.text).toMatch(field);
    }

    // Nothing was written: no Document, Term, Decision, Artifact, Version or Attachment.
    expect(await read()).toEqual(before);
    // Null still moves a Document to the top, and an Agent can't change a Decision's status by naming one.
    const top = await call(client, "edit_document", { document: document.id, parent: null, position: 0 });
    expect(top).toEqual({ isError: false, json: expect.objectContaining({ parentId: null, position: 0 }) });
    const text = await call(client, "edit_decision", { decision: decision.id, baseVersion: 1, title: "Use it", status: "accepted" });
    expect(text).toEqual({ isError: false, json: expect.objectContaining({ title: "Use it", status: "proposed" }) });
  });

  test("the knowledge tools' inputs carry the routes' field descriptions and limits", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const { tools } = await client.listTools();
    const input = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const fields = (name: string) => Object.keys(input(name).properties).sort();

    expect(input("create_document").properties.title).toEqual(expect.objectContaining({ maxLength: 300, pattern: "\\S" }));
    expect(input("create_document").properties.body).toEqual(expect.objectContaining({ maxLength: 500_000, description: "Markdown." }));
    // The tools name a Document's parent their own way, by its slug or id.
    expect(fields("create_document")).toEqual(["body", "parent", "position", "project", "title"]);
    expect(fields("edit_document")).toEqual(["baseVersion", "body", "document", "parent", "position", "title"]);
    expect(input("edit_document").required).toEqual(["document"]);
    expect(input("edit_document").properties.position).toEqual(
      expect.objectContaining({ minimum: 0, description: expect.stringContaining("counting from 0") }),
    );
    expect(input("replace_section").properties.section).toEqual(expect.objectContaining({ maxLength: 1000 }));
    expect(input("replace_section").properties.body).toEqual(expect.objectContaining({ maxLength: 500_000 }));
    expect(input("replace_section").required?.sort()).toEqual(["baseVersion", "body", "document", "section"]);

    expect(input("create_term").properties.name).toEqual(expect.objectContaining({ maxLength: 200, pattern: "\\S" }));
    expect(input("create_term").properties.avoid).toEqual(
      expect.objectContaining({ maxItems: 50, items: expect.objectContaining({ maxLength: 200 }) }),
    );
    expect(input("edit_term").properties.definition).toEqual(expect.objectContaining({ maxLength: 20_000 }));
    expect(input("edit_term").required?.sort()).toEqual(["baseVersion", "term"]);

    // Agents are offered a Decision's text, never its status.
    expect(fields("propose_decision")).toEqual(["body", "project", "title"]);
    expect(fields("edit_decision")).toEqual(["baseVersion", "body", "decision", "title"]);
    expect(input("edit_decision").required?.sort()).toEqual(["baseVersion", "decision"]);
    expect(input("propose_decision").properties.body).toEqual(
      expect.objectContaining({ maxLength: 500_000, description: expect.stringContaining("reasoning") }),
    );

    expect(fields("create_artifact")).toEqual(["description", "files", "page", "project", "run", "title"]);
    expect(input("create_artifact").properties.files).toEqual(expect.objectContaining({ maxItems: 1000 }));
    expect(input("create_artifact").properties.description).toEqual(
      expect.objectContaining({ maxLength: 10_000, description: "What it shows, in a sentence or two." }),
    );
    expect(JSON.stringify(input("create_artifact").properties.page)).toContain("`index.html` when left out");
    expect(input("save_artifact").required?.sort()).toEqual(["artifact", "baseVersion"]);
    expect(input("save_artifact").properties.remove).toEqual(expect.objectContaining({ maxItems: 1000 }));
    expect(input("attach_file").properties.name).toEqual(
      expect.objectContaining({ maxLength: 255, pattern: "\\S", description: "The file's name, such as `screenshot.png`." }),
    );
  });

  /** Calls each tool with a value its route refuses: each is a validation error naming the field. */
  async function expectRefused(client: Client, refusals: [string, Record<string, unknown>, RegExp][]) {
    for (const [tool, args, field] of refusals) {
      const result = await client.callTool({ name: tool, arguments: args });
      const [content] = result.content as { type: string; text: string }[];
      expect({ tool, args, isError: result.isError }).toEqual({ tool, args, isError: true });
      // The tool's own input check, before it calls the API.
      expect(content!.text).toMatch(/^MCP error -32602: Input validation error/);
      expect(content!.text).toMatch(field);
    }
  }

  test("a value a Project-board route refuses is refused by its tool, before anything is written", async () => {
    const { workspace, cookie, ticket, secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const { json: before } = await call(client, "read_project", { project: "CRONK" });
    const outcomes = [
      { name: "done", status: "Ready", default: true },
      { name: "needs you", status: "Backlog", needsYou: true },
    ];
    const step = { project: "CRONK", status: "Ready", brief: "Do it.", model: "sonnet", outcomes };

    await expectRefused(client, [
      // Length, and a name that is only spaces.
      ["create_project", { name: "x".repeat(201), key: "DOCS" }, /name/],
      ["add_status", { project: "CRONK", name: "x".repeat(101), kind: "active" }, /name/],
      ["add_status", { project: "CRONK", name: "   ", kind: "active" }, /name/],
      ["edit_status", { project: "CRONK", status: "Ready", name: "   " }, /name/],
      ["set_step", { ...step, brief: " " }, /brief/],
      ["set_step", { ...step, outcomes: [...outcomes, { name: "x".repeat(51), status: "Done" }] }, /name/],
      // Pattern.
      ["create_project", { name: "Docs", key: "1DOCS" }, /key/],
      ["set_step", { ...step, model: "two words" }, /model/],
      // Minimum and maximum.
      ["add_status", { project: "CRONK", name: "Design", kind: "active", position: -1 }, /position/],
      ["set_step", { ...step, roundLimit: 101 }, /roundLimit/],
      // Enum.
      ["add_status", { project: "CRONK", name: "Design", kind: "weird" }, /kind/],
      ["edit_status", { project: "CRONK", status: "Ready", kind: "weird" }, /kind/],
      ["set_step", { ...step, kind: "weird" }, /kind/],
      ["set_step", { ...step, labelRule: { kind: "weird", label: "docs" } }, /labelRule/],
      // Item counts.
      ["set_step", { ...step, outcomes: outcomes.slice(0, 1) }, /outcomes/],
    ]);

    // Nothing was written: the board and the Workspace's Projects are as they were.
    expect((await call(client, "read_project", { project: "CRONK" })).json).toEqual(before);
    const projects = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/projects`, { cookie })).json();
    expect(projects.map((p: { key: string }) => p.key)).toEqual(["CRONK"]);
    expect(ticket.projectId).toBe(before.id);
    // The same Step within the limits goes through, its round limit and Label rule left to their defaults.
    const stepped = await call(client, "set_step", step);
    expect(stepped.isError).toBe(false);
    const ready = stepped.json.statuses.find((s: { name: string }) => s.name === "Ready");
    expect(ready.step).toEqual(expect.objectContaining({ kind: "ordinary", roundLimit: 2, labelRule: null }));
  });

  test("a value finish or merge_pull_request refuses is refused before the Run ends", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const project = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: agent.id, statusId: triage } });
    const client = await connect(secret);
    const { json: before } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    const run = before.runs[0].id;

    await expectRefused(client, [
      // Length, and a Report that is only spaces.
      ["finish", { run, outcome: "x".repeat(51) }, /outcome/],
      ["finish", { run, outcome: "" }, /outcome/],
      ["finish", { run, outcome: "ready", report: "   " }, /report/],
      ["finish", { run, outcome: "ready", question: "" }, /question/],
      // Integer.
      ["merge_pull_request", { run, pullRequest: 1.5 }, /pullRequest/],
    ]);

    // Nothing was written: the Run still runs, and the Ticket is where it was, with no Report.
    const { json: after } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(after.runs).toEqual([expect.objectContaining({ id: run, state: "running" })]);
    expect(after.ticket.statusId).toBe(triage);
    expect(after.reports).toEqual([]);
    expect((await call(client, "finish", { run, outcome: "ready", report: "Clear." })).isError).toBe(false);
  });

  test("the board, finish and merge tools' inputs carry the routes' field descriptions and limits", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const { tools } = await client.listTools();
    const input = (name: string) => tools.find((tool) => tool.name === name)!.inputSchema as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };

    const create = input("create_project");
    expect(Object.keys(create.properties).sort()).toEqual(["key", "name"]);
    expect(create.properties.name).toEqual(expect.objectContaining({ maxLength: 200, pattern: "\\S" }));
    expect(create.properties.key).toEqual(
      expect.objectContaining({ pattern: "^[A-Za-z][A-Za-z0-9]{1,9}$", description: expect.stringContaining("capitals") }),
    );
    const add = input("add_status");
    expect(Object.keys(add.properties).sort()).toEqual(["kind", "name", "position", "project"]);
    expect(add.required?.sort()).toEqual(["kind", "name", "project"]);
    expect(add.properties.name).toEqual(expect.objectContaining({ maxLength: 100, pattern: "\\S" }));
    expect(add.properties.position).toEqual(expect.objectContaining({ minimum: 0, description: expect.stringContaining("board") }));
    expect(JSON.stringify(add.properties.kind)).toContain("canceled");
    expect(String(add.properties.kind!.description)).toContain("What the Status means");
    expect(Object.keys(input("edit_status").properties).sort()).toEqual(["kind", "name", "position", "project", "status"]);

    // set_step is the documented exception: its Outcomes name their Status, where the route takes `statusId`.
    const step = input("set_step");
    expect(Object.keys(step.properties).sort()).toEqual(
      ["brief", "kind", "labelRule", "model", "outcomes", "project", "roundLimit", "status"],
    );
    expect(step.properties.brief).toEqual(expect.objectContaining({ maxLength: 50_000, pattern: "\\S" }));
    expect(step.properties.model).toEqual(expect.objectContaining({ maxLength: 50, pattern: "^\\S+$" }));
    expect(step.properties.roundLimit).toEqual(expect.objectContaining({ minimum: 0, maximum: 100 }));
    expect(step.properties.outcomes).toEqual(expect.objectContaining({ minItems: 2, maxItems: 20 }));
    expect(JSON.stringify(step.properties.outcomes)).toContain("Unique within the Step");

    const finish = input("finish");
    expect(Object.keys(finish.properties).sort()).toEqual(["outcome", "question", "report", "run"]);
    expect(finish.required?.sort()).toEqual(["outcome", "run"]);
    expect(finish.properties.outcome).toEqual(expect.objectContaining({ maxLength: 50 }));
    expect(finish.properties.question).toEqual(expect.objectContaining({ maxLength: 100_000 }));
    expect(finish.properties.report).toEqual(
      expect.objectContaining({ maxLength: 500_000, pattern: "\\S", description: expect.stringContaining("Triage report") }),
    );
    const merge = input("merge_pull_request");
    expect(Object.keys(merge.properties).sort()).toEqual(["pullRequest", "run"]);
    expect(merge.properties.pullRequest).toEqual(
      expect.objectContaining({ type: "integer", description: expect.stringContaining("GitHub's id") }),
    );
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
    expect(linked).toEqual({ isError: false, json: { id: design.id, projectId: project.id, title: "Sign-in design", slug: design.slug } });
    const refused = await call(client, "link_document", { ticket: "CRONK-2", document: design.id });
    expect(refused).toEqual({ isError: true, json: expect.objectContaining({ code: "no_running_run" }) });

    const unlinked = await call(client, "unlink_document", { ticket: "CRONK-1", document: design.id });
    expect(unlinked.isError).toBe(false);
    const { json: read } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(read.linkedDocuments).toEqual([]);
  });

  test("during its Run an Agent creates an Artifact linked to its Ticket, and links and unlinks others", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const project = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: agent.id, statusId: status("Triage") } });
    const [run] = await (await cronk.request("GET", `/api/tickets/${ticket.id}/runs`, { cookie })).json();
    const files = [{ path: "index.html", contentBase64: Buffer.from("<p>Hi</p>").toString("base64") }];
    const sketch = await post(cookie, `/api/projects/${project.id}/artifacts`, { title: "Sketch", files });
    const client = await connect(secret);

    const created = await call(client, "create_artifact", { project: "CRONK", title: "Board prototype", files, run: run.id });
    const linked = await call(client, "link_artifact", { ticket: "CRONK-1", artifact: sketch.id });
    const refused = await call(client, "link_artifact", { ticket: "CRONK-2", artifact: sketch.id });
    const { json: read } = await call(client, "read_ticket", { ticket: "CRONK-1" });
    const unlinked = await call(client, "unlink_artifact", { ticket: "CRONK-1", artifact: sketch.id });

    expect(created.isError).toBe(false);
    expect(linked).toEqual({ isError: false, json: { id: sketch.id, projectId: project.id, title: "Sketch", slug: sketch.slug } });
    expect(refused).toEqual({ isError: true, json: expect.objectContaining({ code: "no_running_run" }) });
    expect(read.linkedArtifacts).toEqual([
      { id: created.json.id, projectId: project.id, title: "Board prototype", slug: created.json.slug },
      { id: sketch.id, projectId: project.id, title: "Sketch", slug: sketch.slug },
    ]);
    expect(unlinked).toEqual({
      isError: false,
      json: [{ id: created.json.id, projectId: project.id, title: "Board prototype", slug: created.json.slug }],
    });
  });

  test("during its Run an Agent attaches files as base64 to its Ticket and to the Report it writes", async () => {
    const { cookie, ticket, agent, secret } = await workspaceWithTicket();
    const runner = await post(cookie, "/api/runners", { name: "Fake", kind: "fake" });
    await cronk.request("PATCH", `/api/agents/${agent.id}`, { cookie, body: { runnerId: runner.id } });
    const project = await (await cronk.request("GET", `/api/projects/${ticket.projectId}`, { cookie })).json();
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
    await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { delegateId: agent.id, statusId: triage } });
    const client = await connect(secret);
    const report = await call(client, "write_report", { ticket: "CRONK-1", title: "Findings", body: "See the log." });

    const onTicket = await call(client, "attach_file", {
      ticket: "CRONK-1",
      name: "trace.log",
      mediaType: "text/plain",
      contentBase64: Buffer.from("boom").toString("base64"),
    });
    const onReport = await call(client, "attach_file", {
      document: report.json.id,
      name: "screen.png",
      mediaType: "image/png",
      contentBase64: Buffer.from("png").toString("base64"),
    });

    expect(onTicket).toEqual({ isError: false, json: expect.objectContaining({ name: "trace.log", size: 4, on: { kind: "ticket", id: ticket.id } }) });
    expect(onReport).toEqual({ isError: false, json: expect.objectContaining({ name: "screen.png", on: { kind: "document", id: report.json.id } }) });
    const read = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(read.json.attachments).toEqual([onTicket.json]);
    const reportAttachments = await (await cronk.request("GET", `/api/documents/${report.json.id}/attachments`, { cookie })).json();
    expect(reportAttachments).toEqual([onReport.json]);
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
    await call(client, "file_ticket", { project: "CRONK", title: "After the running one" });
    const waits = await call(client, "add_block", { ticket: "CRONK-5", blockedBy: "CRONK-1" });
    expect(waits.isError).toBe(false);
    expect(waits.json).toEqual(expect.objectContaining({ kind: "blockedBy", ticket: expect.objectContaining({ key: "CRONK-1" }) }));
    for (const args of [{ ticket: "CRONK-5" }, { ticket: "CRONK-5", blocks: "CRONK-2", blockedBy: "CRONK-2" }]) {
      const unclear = await call(client, "add_block", args);
      expect(unclear).toEqual({ isError: true, json: expect.objectContaining({ code: "one_side_of_block", rule: expect.any(String) }) });
    }
    const noProject = await call(client, "file_ticket", { project: "NOPE", title: "Lost" });
    expect(noProject).toEqual({ isError: true, json: expect.objectContaining({ code: "unknown_project", advice: expect.stringContaining("CRONK") }) });
  });

  test("outside a Run an Agent files a ticket set: a Discovered Ticket split into Sub-Tickets, one blocking another", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const plan = await call(client, "file_ticket", { project: "CRONK", title: "The plan" });
    const first = await call(client, "create_sub_ticket", { ticket: "CRONK-3", title: "First slice" });
    const second = await call(client, "create_sub_ticket", { ticket: "CRONK-3", title: "Second slice" });
    const blocked = await call(client, "add_block", { ticket: "CRONK-4", blocks: "CRONK-5" });

    expect([plan.isError, first.isError, second.isError, blocked.isError]).toEqual([false, false, false, false]);
    expect(second.json).toEqual(
      expect.objectContaining({ key: "CRONK-5", parentId: plan.json.id, discovered: expect.objectContaining({ waiting: true }) }),
    );
    const refused = await call(client, "create_sub_ticket", { ticket: "CRONK-1", title: "Not mine" });
    expect(refused).toEqual({ isError: true, json: expect.objectContaining({ code: "no_running_run", rule: expect.any(String) }) });
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
    // A Document is named by its slug too, whose words may be stale.
    const current = await call(client, "read_document", { document: setup.json.slug });
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

  test("an Agent reads and replaces one Section of a Document", async () => {
    const { agent, secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const setup = await call(client, "create_document", {
      project: "CRONK",
      title: "Setup",
      body: "# Setup\n\n## Install\n\n### Linux\n\napt install cronk\n\n## Uninstall\n\n### Linux\n\napt remove cronk\n",
    });

    const read = await call(client, "read_section", { document: setup.json.slug, section: "Install/Linux" });
    expect(read).toEqual({
      isError: false,
      json: expect.objectContaining({ path: "Setup/Install/Linux", body: "### Linux\n\napt install cronk" }),
    });
    const replaced = await call(client, "replace_section", {
      document: setup.json.id,
      section: "Install/Linux",
      baseVersion: read.json.version.number,
      body: "### Linux\n\nsnap install cronk",
    });
    expect(replaced.json).toEqual(
      expect.objectContaining({
        body: "### Linux\n\nsnap install cronk",
        version: expect.objectContaining({ number: 2, actor: { kind: "agent", id: agent.id, name: "claude-max" } }),
      }),
    );
    const ambiguous = await call(client, "read_section", { document: setup.json.id, section: "Linux" });
    expect(ambiguous).toEqual({
      isError: true,
      json: expect.objectContaining({ code: "section_ambiguous", candidates: ["Setup/Install/Linux", "Setup/Uninstall/Linux"] }),
    });
    const outdated = await call(client, "replace_section", {
      document: setup.json.id,
      section: "Uninstall",
      baseVersion: 1,
      body: "## Uninstall\n\nGone.",
    });
    expect(outdated.json).toEqual(expect.objectContaining({ code: "outdated_version", current: expect.objectContaining({ number: 2 }) }));
  });

  test("an Agent creates, edits and reads Terms of a Project and the Workspace, and reads a Project's glossary", async () => {
    const { cookie, agent, secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const workspaceRun = await call(client, "create_term", { name: "Run", definition: "One agent execution.", avoid: ["job"] });
    const ticket = await call(client, "create_term", { name: "Ticket", definition: "A unit of work." });
    const projectRun = await call(client, "create_term", { project: "cronk", name: "run", definition: "Here: a session." });
    expect([workspaceRun.isError, ticket.isError, projectRun.isError]).toEqual([false, false, false]);
    expect(workspaceRun.json).toEqual(expect.objectContaining({ projectId: null, name: "Run", avoid: ["job"] }));
    const taken = await call(client, "create_term", { project: "CRONK", name: "RUN" });
    expect(taken).toEqual({ isError: true, json: expect.objectContaining({ code: "term_name_taken" }) });

    const saved = await call(client, "edit_term", { term: projectRun.json.id, baseVersion: 1, avoid: ["session"] });
    expect(saved.json.version).toEqual(expect.objectContaining({ number: 2, actor: { kind: "agent", id: agent.id, name: "claude-max" } }));
    const outdated = await call(client, "edit_term", { term: projectRun.json.id, baseVersion: 1, definition: "Stale." });
    expect(outdated.isError).toBe(true);
    expect(outdated.json).toEqual(
      expect.objectContaining({ code: "outdated_version", current: expect.objectContaining({ number: 2, avoid: ["session"] }) }),
    );

    const glossary = await call(client, "read_glossary", { project: "CRONK" });
    expect(glossary.json.map((t: { name: string; definition: string }) => [t.name, t.definition])).toEqual([
      ["run", "Here: a session."],
      ["Ticket", "A unit of work."],
    ]);
    const workspaceTerms = await call(client, "read_glossary", {});
    expect(workspaceTerms.json.map((t: { name: string }) => t.name)).toEqual(["Run", "Ticket"]);
    const read = await call(client, "read_term", { term: projectRun.json.id });
    expect(read.json).toEqual(expect.objectContaining({ name: "run", avoid: ["session"] }));
    const versions = await call(client, "list_term_versions", { term: projectRun.json.id });
    expect(versions.json.map((v: { number: number; avoid: string[] }) => [v.number, v.avoid])).toEqual([
      [1, []],
      [2, ["session"]],
    ]);
    // A Term is named by its readable form too: its name after its Project's key.
    const first = await call(client, "read_term", { term: "CRONK/RUN", version: 1 });
    expect(first.json).toEqual(expect.objectContaining({ number: 1, name: "run", avoid: [] }));
    const compared = await call(client, "compare_term_versions", { term: projectRun.json.id, from: 1, to: 2 });
    expect(compared.json.avoid).toEqual([{ change: "added", text: "session" }]);
    const viaApi = await (await cronk.request("GET", `/api/terms/${projectRun.json.id}`, { cookie })).json();
    expect(viaApi.avoid).toEqual(["session"]);
  });

  test("an Agent attaches files as base64 to a Document and its own Comment, and reads a Ticket's Attachments", async () => {
    const { cookie, ticket, secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const document = await call(client, "create_document", { title: "Findings" });
    const comment = await call(client, "comment", { ticket: "CRONK-1", body: "Screenshot attached." });
    // Larger than a request's usual limit, as screenshots often are.
    const screenshot = Buffer.alloc(2 * 1024 * 1024, 7);

    const onDocument = await call(client, "attach_file", {
      document: document.json.id,
      name: "notes.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("It works.").toString("base64"),
    });
    const onComment = await call(client, "attach_file", {
      comment: comment.json.id,
      name: "screen.png",
      mediaType: "image/png",
      contentBase64: screenshot.toString("base64"),
    });
    const onTicket = await call(client, "attach_file", {
      ticket: "CRONK-1",
      name: "x.txt",
      mediaType: "text/plain",
      contentBase64: "eA==",
    });
    const onAdasTicket = await post(cookie, `/api/tickets/${ticket.id}/comments`, { body: "Mine." });
    const notTheirs = await call(client, "attach_file", { comment: onAdasTicket.id, name: "x.txt", contentBase64: "eA==" });

    expect(onDocument).toEqual({
      isError: false,
      json: expect.objectContaining({ name: "notes.txt", size: 9, on: { kind: "document", id: document.json.id } }),
    });
    expect(onComment.json).toEqual(expect.objectContaining({ mediaType: "image/png", size: 2 * 1024 * 1024 }));
    const downloaded = await cronk.request("GET", `/api/attachments/${onComment.json.id}/content`, { cookie });
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(screenshot)).toBe(true);
    expect(onTicket).toEqual({ isError: true, json: expect.objectContaining({ code: "no_running_run" }) });
    expect(notTheirs).toEqual({ isError: true, json: expect.objectContaining({ code: "not_comment_author" }) });
    const read = await call(client, "read_ticket", { ticket: "CRONK-1" });
    expect(read.json.attachments).toEqual([]);
    expect(read.json.comments.find((c: { id: string }) => c.id === comment.json.id).attachments).toEqual([onComment.json]);
  });

  test("a file that isn't base64, goes to two places at once, or is over the limit is refused", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const document = await call(client, "create_document", { title: "Findings" });

    const notBase64 = await call(client, "attach_file", { document: document.json.id, name: "x", contentBase64: "not base64!" });
    const twoTargets = await call(client, "attach_file", {
      document: document.json.id,
      ticket: "CRONK-1",
      name: "x",
      contentBase64: "eA==",
    });
    const tooLarge = await call(client, "attach_file", {
      document: document.json.id,
      name: "huge.bin",
      contentBase64: Buffer.alloc(25 * 1024 * 1024 + 1).toString("base64"),
    });

    expect(notBase64.json.code).toBe("invalid_base64");
    expect(twoTargets.json.code).toBe("one_target");
    expect(tooLarge.json).toEqual(expect.objectContaining({ code: "attachment_too_large", message: "An Attachment may be at most 25 MB." }));
  });

  test("an Agent proposes Decisions in a Project and the Workspace, edits their text and reads their Versions", async () => {
    const { cookie, agent, secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const postgres = await call(client, "propose_decision", { project: "cronk", title: "Use Postgres", body: "It's boring." });
    const fastify = await call(client, "propose_decision", { project: "CRONK", title: "Use Fastify" });
    const english = await call(client, "propose_decision", { title: "Write in English" });
    expect(postgres.json).toEqual(expect.objectContaining({ number: 1, status: "proposed", projectId: expect.any(String) }));
    expect([fastify.json.number, english.json.number, english.json.projectId]).toEqual([2, 1, null]);

    const saved = await call(client, "edit_decision", { decision: postgres.json.id, baseVersion: 1, body: "It's boring.\nIt works." });
    expect(saved.json.version).toEqual(expect.objectContaining({ number: 2, actor: { kind: "agent", id: agent.id, name: "claude-max" } }));
    const outdated = await call(client, "edit_decision", { decision: postgres.json.id, baseVersion: 1, body: "Stale." });
    expect(outdated).toEqual({ isError: true, json: expect.objectContaining({ code: "outdated_version" }) });

    const listed = await call(client, "list_decisions", { project: "cronk" });
    expect(listed.json.map((d: { number: number; title: string }) => [d.number, d.title])).toEqual([
      [1, "Use Postgres"],
      [2, "Use Fastify"],
    ]);
    expect((await call(client, "list_decisions", {})).json.map((d: { title: string }) => d.title)).toEqual(["Write in English"]);
    // A Decision is named by its readable form too: its number after its Project's key.
    const first = await call(client, "read_decision", { decision: "CRONK/1", version: 1 });
    expect(first.json).toEqual(expect.objectContaining({ number: 1, body: "It's boring." }));
    const versions = await call(client, "list_decision_versions", { decision: postgres.json.id });
    expect(versions.json.map((v: { number: number }) => v.number)).toEqual([1, 2]);
    const compared = await call(client, "compare_decision_versions", { decision: postgres.json.id, from: 1, to: 2 });
    expect(compared.json.lines).toEqual([
      { change: "same", text: "It's boring." },
      { change: "added", text: "It works." },
    ]);

    await cronk.request("PATCH", `/api/decisions/${postgres.json.id}`, { cookie, body: { baseVersion: 2, status: "accepted" } });
    const current = await call(client, "read_decision", { decision: postgres.json.id });
    expect(current.json).toEqual(expect.objectContaining({ status: "accepted", body: "It's boring.\nIt works." }));
  });

  test("an Agent exports a Project's or the Workspace's Terms and Decisions as files to commit into its branch", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);
    await call(client, "create_term", { name: "Ticket", definition: "A unit of work." });
    await call(client, "create_term", { project: "CRONK", name: "Board", definition: "The Statuses as columns." });
    await call(client, "propose_decision", { project: "CRONK", title: "Use Postgres", body: "It's boring." });

    const project = await call(client, "export_knowledge", { project: "cronk" });
    const workspace = await call(client, "export_knowledge", {});

    expect(project.json).toEqual({
      files: [
        { path: "GLOSSARY.md", content: "# Glossary\n\n**Board**:\nThe Statuses as columns.\n\n**Ticket**:\nA unit of work.\n" },
        { path: "docs/adr/0001-use-postgres.md", content: "# Use Postgres\n\nStatus: proposed\n\nIt's boring.\n" },
      ],
    });
    expect(workspace.json).toEqual({ files: [{ path: "GLOSSARY.md", content: "# Glossary\n\n**Ticket**:\nA unit of work.\n" }] });
  });

  test("an Agent reads a Project's board and changes its Statuses and Steps, naming Statuses by name", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const board = await call(client, "read_project", { project: "cronk" });
    expect(board.isError).toBe(false);
    expect(board.json).toEqual(expect.objectContaining({ key: "CRONK", access: "write" }));

    const added = await call(client, "add_status", { project: "CRONK", name: "Design", kind: "active", position: 1 });
    expect(added.json.statuses[1]).toEqual(expect.objectContaining({ name: "Design", kind: "active", step: null }));
    const edited = await call(client, "edit_status", { project: "CRONK", status: "design", name: "Sketch" });
    expect(edited.json.statuses[1].name).toBe("Sketch");

    const stepped = await call(client, "set_step", {
      project: "CRONK",
      status: "Sketch",
      brief: "Sketch the screens.",
      model: "sonnet",
      outcomes: [
        { name: "sketched", status: "Ready", default: true },
        { name: "needs you", status: "backlog", needsYou: true },
      ],
    });
    expect(stepped.isError).toBe(false);
    const ids = new Map<string, string>(stepped.json.statuses.map((s: { name: string; id: string }) => [s.name, s.id]));
    expect(stepped.json.statuses[1].step).toEqual({
      kind: "ordinary",
      brief: "Sketch the screens.",
      model: "sonnet",
      roundLimit: 2,
      labelRule: null,
      outcomes: [
        { name: "sketched", statusId: ids.get("Ready"), default: true, needsYou: false, countsAsRound: false },
        { name: "needs you", statusId: ids.get("Backlog"), default: false, needsYou: true, countsAsRound: false },
      ],
    });

    const refused = await call(client, "remove_status", { project: "CRONK", status: "Backlog" });
    expect(refused).toEqual({ isError: true, json: expect.objectContaining({ code: "status_has_tickets" }) });
    const unknown = await call(client, "remove_status", { project: "CRONK", status: "Nowhere" });
    expect(unknown).toEqual({ isError: true, json: expect.objectContaining({ code: "unknown_status" }) });

    expect((await call(client, "remove_step", { project: "CRONK", status: "Sketch" })).json.statuses[1].step).toBeNull();
    const removed = await call(client, "remove_status", { project: "CRONK", status: "Sketch" });
    expect(removed.json.statuses.map((s: { name: string }) => s.name)).not.toContain("Sketch");
  });

  test("an Agent whose Owner is an Admin creates a Project with the default board, then uses it", async () => {
    const { secret } = await workspaceWithTicket();
    const client = await connect(secret);

    const created = await call(client, "create_project", { name: "Docs", key: "docs" });
    expect(created.isError).toBe(false);
    expect(created.json).toEqual(expect.objectContaining({ name: "Docs", key: "DOCS", visibility: "open", access: "write" }));
    expect(created.json.statuses.map((s: { name: string }) => s.name)).toEqual([
      "Backlog", "Triage", "Ready", "Investigate", "Implement", "Code review", "Merge", "In Review", "Done", "Canceled",
    ]);
    expect((await call(client, "read_project", { project: "DOCS" })).json).toEqual(created.json);
    const added = await call(client, "add_status", { project: "docs", name: "Design", kind: "active" });
    expect(added.isError).toBe(false);

    const taken = await call(client, "create_project", { name: "Other", key: "Cronk" });
    expect(taken).toEqual({ isError: true, json: expect.objectContaining({ code: "project_key_taken" }) });
  });

  test("an Agent whose Owner isn't an Admin, or with a read-only token, doesn't create a Project", async () => {
    const { workspace, cookie, secret: readOnly } = await workspaceWithTicket("read");
    const refused = await call(await connect(readOnly), "create_project", { name: "Docs", key: "DOCS" });
    expect(refused).toEqual({ isError: true, json: expect.objectContaining({ code: "read_only_token", rule: expect.any(String) }) });

    const grace = await addMember(cronk, cookie, workspace.id, "grace@example.com");
    const agent = await post(grace.cookie, `/api/workspaces/${workspace.id}/agents`, { name: "grace-claude" });
    const { secret } = await post(grace.cookie, `/api/agents/${agent.id}/tokens`, { name: "laptop", access: "full" });
    const notAdmin = await call(await connect(secret), "create_project", { name: "Docs", key: "DOCS" });
    expect(notAdmin).toEqual({
      isError: true,
      json: expect.objectContaining({ code: "agent_not_allowed", rule: expect.stringContaining("Owner is an Admin") }),
    });
    const keys = (await (await cronk.request("GET", `/api/workspaces/${workspace.id}/projects`, { cookie: grace.cookie })).json())
      .map((p: { key: string }) => p.key);
    expect(keys).toEqual(["CRONK"]);
  });

  test("a revoked token is refused at once, even on an open connection", async () => {
    const { cookie, agent, secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const [token] = await (await cronk.request("GET", `/api/agents/${agent.id}/tokens`, { cookie })).json();

    await cronk.request("DELETE", `/api/agents/${agent.id}/tokens/${token.id}`, { cookie });

    await expect(client.callTool({ name: "read_ticket", arguments: { ticket: "CRONK-1" } })).rejects.toThrow();
  });

  test("an Agent creates, saves, reads and lists Artifacts, with files as base64", async () => {
    const { cookie, secret } = await workspaceWithTicket();
    const client = await connect(secret);
    const base64 = (text: string) => Buffer.from(text).toString("base64");

    const created = await call(client, "create_artifact", {
      project: "cronk",
      title: "Board prototype",
      description: "Drag and drop.",
      files: [
        { path: "index.html", contentBase64: base64("<script src=app.js></script>") },
        { path: "app.js", contentBase64: base64("1"), mediaType: "text/javascript" },
      ],
    });
    expect(created.isError).toBe(false);
    expect(created.json).toMatchObject({ title: "Board prototype", version: { number: 1, actor: { kind: "agent" } } });

    const saved = await call(client, "save_artifact", {
      artifact: created.json.id,
      baseVersion: 1,
      files: [{ path: "app.js", contentBase64: base64("2") }],
      remove: [],
    });
    expect(saved.json).toMatchObject({ version: { number: 2 } });
    const outdated = await call(client, "save_artifact", { artifact: created.json.id, baseVersion: 1, title: "Again" });
    expect(outdated).toEqual({ isError: true, json: expect.objectContaining({ code: "outdated_version" }) });

    const read = await call(client, "read_artifact", { artifact: created.json.slug });
    const byApi = await (await cronk.request("GET", `/api/artifacts/${created.json.id}`, { cookie })).json();
    expect(read.json).toEqual(byApi);
    const readFile = await call(client, "read_artifact", { artifact: created.json.id, path: "app.js" });
    expect(readFile.json).toEqual({ path: "app.js", mediaType: "text/javascript", size: 1, contentBase64: base64("2") });

    const listed = await call(client, "list_artifacts", { project: "CRONK" });
    expect(listed.json.map((artifact: { id: string }) => artifact.id)).toEqual([created.json.id]);
    expect((await call(client, "list_artifacts", {})).json).toEqual([]);
  });
});
