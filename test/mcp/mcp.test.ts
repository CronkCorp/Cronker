import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
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
      "attach_file",
      "comment",
      "compare_decision_versions",
      "compare_term_versions",
      "compare_versions",
      "create_artifact",
      "create_document",
      "create_sub_ticket",
      "create_term",
      "edit_decision",
      "edit_document",
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
      "read_section",
      "read_term",
      "read_ticket",
      "replace_section",
      "save_artifact",
      "search",
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
      },
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
