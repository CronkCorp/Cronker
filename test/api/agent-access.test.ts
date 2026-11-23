import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Agent Access (ADR 0010): Admins set how far Agents may go in each Project, and in the Workspace's own knowledge,
 * Write, Read or None. An Agent may do the least of that, its Owner's Access and its token's access.
 */

let cronk: StartedCronk;
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await cronk?.stop();
});

interface As {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: As, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: As, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/** A member's Agent `name`, using a fake Runner of theirs, with a full and a read-only token. */
async function agentOf(as: As, workspaceId: string, name: string) {
  const runner = await ok("POST", "/api/runners", as, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspaceId}/agents`, as, { name });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, as, { runnerId: runner.id });
  const full = await ok("POST", `/api/agents/${agent.id}/tokens`, as, { name: "cloud", access: "full" });
  const read = await ok("POST", `/api/agents/${agent.id}/tokens`, as, { name: "reader", access: "read" });
  const bearer = (secret: string) => ({ headers: { authorization: `Bearer ${secret}` } });
  return { ...agent, secret: full.secret as string, as: bearer(full.secret), reader: bearer(read.secret) };
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

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: result.isError ?? false, text: content!.text };
}

type ProjectAccess = {
  visibility: "open" | "private";
  users: { userId: string; level: "write" | "read" }[];
  agentAccess?: "write" | "read" | "none";
};

/**
 * Ada, the Admin, with an open Project CRONK on the default board holding a Document, and Workspace knowledge; Bea, a
 * member, whose Agent `bea-claude` runs on her Ticket CRONK-1 in Triage; Bea's CRONK-2 is assigned to her, not
 * delegated. A second Project OTHER holds Bea's OTHER-1, delegated and running too.
 */
async function beaAtWork() {
  cronk = await startCronk();
  const { workspace, user } = await setUp(cronk);
  const ada = { id: user.id, cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
  const status = (p: { statuses: { name: string; id: string }[] }, name: string) => p.statuses.find((s) => s.name === name)!.id;
  const added = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
  const bea = { id: added.user.id, cookie: added.cookie };
  const agent = await agentOf(bea, workspace.id, "bea-claude");
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, bea, { title: "Bea's work" });
  await ok("PATCH", `/api/tickets/${ticket.id}`, bea, { delegateId: agent.id, statusId: status(project, "Triage") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const own = await ok("POST", `/api/projects/${project.id}/tickets`, bea, { title: "Bea's own" });
  await ok("PATCH", `/api/tickets/${own.id}`, bea, { assigneeId: bea.id });
  const elsewhere = await ok("POST", `/api/projects/${other.id}/tickets`, bea, { title: "Bea's other work" });
  await ok("PATCH", `/api/tickets/${elsewhere.id}`, bea, { delegateId: agent.id, statusId: status(other, "Triage") });
  const [otherRun] = await ok("GET", `/api/tickets/${elsewhere.id}/runs`, ada);
  const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });
  const handbook = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Handbook", body: "One." });
  const open = { visibility: "open", users: [] } as const;
  const setAgentAccess = (agentAccess: "write" | "read" | "none", as: As = ada) =>
    call("PUT", `/api/projects/${project.id}/access`, as, { ...open, agentAccess });
  const preview = (access: ProjectAccess, as: As = ada) => call("POST", `/api/projects/${project.id}/access/preview`, as, access);
  const setWorkspaceAgentAccess = (agentAccess: string, as: As = ada) =>
    call("PATCH", `/api/workspaces/${workspace.id}/settings`, as, { agentAccess });
  const inbox = (as: As) => ok("GET", `/api/workspaces/${workspace.id}/inbox`, as);
  return {
    workspace,
    project,
    other,
    status,
    ada,
    bea,
    agent,
    ticket,
    run,
    own,
    elsewhere,
    otherRun,
    document,
    handbook,
    setAgentAccess,
    preview,
    setWorkspaceAgentAccess,
    inbox,
  };
}

describe("the settings", () => {
  test("a migrated or new Project, and the Workspace, start with Agent Access Write", async () => {
    const { workspace, project, ada } = await beaAtWork();

    expect(await ok("GET", `/api/projects/${project.id}/access`, ada)).toEqual({ visibility: "open", users: [], agentAccess: "write" });
    expect(await ok("GET", `/api/workspaces/${workspace.id}/settings`, ada)).toMatchObject({ agentAccess: "write" });
  });

  test("an Admin sets a Project's Agent Access, which a change leaving it out keeps", async () => {
    const { project, ada, setAgentAccess } = await beaAtWork();

    expect(await setAgentAccess("read")).toEqual({ status: 200, json: { visibility: "open", users: [], agentAccess: "read" } });
    expect(await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "private", users: [] })).toEqual({
      visibility: "private",
      users: [],
      agentAccess: "read",
    });
    expect((await setAgentAccess("none")).json.agentAccess).toBe("none");
    expect((await ok("GET", `/api/projects/${project.id}/access`, ada)).agentAccess).toBe("none");
  });

  test("an Admin sets the Workspace's Agent Access", async () => {
    const { workspace, ada, setWorkspaceAgentAccess } = await beaAtWork();

    expect(await setWorkspaceAgentAccess("read")).toMatchObject({ status: 200, json: { agentAccess: "read" } });
    expect(await ok("GET", `/api/workspaces/${workspace.id}/settings`, ada)).toMatchObject({ agentAccess: "read" });
    expect((await setWorkspaceAgentAccess("everything")).status).toBe(400);
  });

  test("only Admins change them; Agents not at all", async () => {
    const { workspace, project, bea, agent, setAgentAccess, preview, setWorkspaceAgentAccess, ada } = await beaAtWork();

    for (const as of [bea, agent.as]) {
      expect((await setAgentAccess("read", as)).status).toBeGreaterThanOrEqual(401);
      expect((await preview({ visibility: "open", users: [], agentAccess: "read" }, as)).status).toBeGreaterThanOrEqual(401);
      expect((await setWorkspaceAgentAccess("read", as)).status).toBeGreaterThanOrEqual(401);
    }
    expect((await setAgentAccess("read", bea)).json.error.code).toBe("not_admin");
    expect((await setWorkspaceAgentAccess("read", bea)).json.error.code).toBe("not_admin");
    expect((await ok("GET", `/api/projects/${project.id}/access`, ada)).agentAccess).toBe("write");
    expect(await ok("GET", `/api/workspaces/${workspace.id}/settings`, ada)).toMatchObject({ agentAccess: "write" });
  });
});

describe("a Project's Agent Access Read", () => {
  test("lets Agents read it and refuses every write with the rule, over the HTTP API", async () => {
    const { project, ticket, document, agent, setAgentAccess } = await beaAtWork();
    await setAgentAccess("read");

    for (const path of [`/api/projects/${project.id}`, `/api/tickets/${ticket.id}`, `/api/documents/${document.id}`]) {
      expect((await call("GET", path, agent.as)).status, path).toBe(200);
    }
    const writes: [string, string, unknown][] = [
      ["POST", `/api/tickets/${ticket.id}/comments`, { body: "Mine." }],
      ["POST", `/api/projects/${project.id}/tickets`, { title: "Found" }],
      ["PATCH", `/api/documents/${document.id}`, { baseVersion: 1, body: "Two." }],
      ["POST", `/api/projects/${project.id}/documents`, { title: "New" }],
      ["POST", `/api/projects/${project.id}/terms`, { name: "Read", definition: "Look." }],
      ["POST", `/api/projects/${project.id}/decisions`, { title: "No", body: "Why." }],
    ];
    for (const [method, path, body] of writes) {
      const response = await call(method, path, agent.as, body);
      expect(response, `${method} ${path}`).toEqual({
        status: 403,
        json: {
          error: {
            code: "read_access",
            message: "You have Read in this Project, so you may only read it.",
            rule: expect.stringContaining("Agent Access"),
            advice: expect.stringContaining("Write"),
          },
        },
      });
    }
  });

  test("refuses filing a Ticket and saving knowledge over MCP, naming the rule", async () => {
    const { ticket, document, agent, setAgentAccess } = await beaAtWork();
    await setAgentAccess("read");
    const client = await connect(agent.secret);

    expect((await tool(client, "read_ticket", { ticket: "CRONK-1" })).isError).toBe(false);
    for (const [name, args] of [
      ["file_ticket", { project: "CRONK", title: "Found on the way" }],
      ["comment", { ticket: ticket.key, body: "Mine." }],
      ["edit_document", { document: document.id, baseVersion: 1, body: "Two." }],
      ["create_term", { project: "CRONK", name: "Read", definition: "Look." }],
    ] as const) {
      const refused = await tool(client, name, args);
      expect(refused.isError, name).toBe(true);
      expect(refused.text, name).toContain("read_access");
      expect(refused.text, name).toContain("Agent Access");
    }
  });
});

describe("a Project's Agent Access None", () => {
  test("answers as not found to Agents, over the HTTP API and MCP, but not to their Owners", async () => {
    const { workspace, project, ticket, document, bea, agent, setAgentAccess } = await beaAtWork();
    await setAgentAccess("none");

    for (const path of [`/api/projects/${project.id}`, `/api/tickets/${ticket.id}`, `/api/documents/${document.id}`]) {
      expect((await call("GET", path, agent.as)).status, path).toBe(404);
      expect((await call("GET", path, bea)).status, path).toBe(200);
    }
    const keys = (await ok("GET", `/api/workspaces/${workspace.id}/projects`, agent.as)).map((p: { key: string }) => p.key);
    expect(keys).toEqual(["OTHER"]);
    const client = await connect(agent.secret);
    const read = await tool(client, "read_ticket", { ticket: "CRONK-1" });
    expect(read.isError).toBe(true);
    expect(read.text).toContain("not_found");
    const filed = await tool(client, "file_ticket", { project: "CRONK", title: "Found" });
    expect(filed.isError).toBe(true);
    expect(filed.text).not.toContain("read_access");
  });
});

describe("the Workspace's Agent Access", () => {
  test("Read caps Agents' writes to the Workspace's own knowledge, and leaves Projects as they were", async () => {
    const { workspace, handbook, document, agent, setWorkspaceAgentAccess } = await beaAtWork();
    await setWorkspaceAgentAccess("read");

    expect((await call("GET", `/api/documents/${handbook.id}`, agent.as)).status).toBe(200);
    const writes: [string, string, unknown][] = [
      ["PATCH", `/api/documents/${handbook.id}`, { baseVersion: 1, body: "Two." }],
      ["POST", `/api/workspaces/${workspace.id}/documents`, { title: "New" }],
      ["POST", `/api/workspaces/${workspace.id}/terms`, { name: "Read", definition: "Look." }],
      ["POST", `/api/workspaces/${workspace.id}/decisions`, { title: "No", body: "Why." }],
    ];
    for (const [method, path, body] of writes) {
      const response = await call(method, path, agent.as, body);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(response.json.error, `${method} ${path}`).toMatchObject({
        code: "read_access",
        message: "You have Read in this Workspace's own knowledge, so you may only read it.",
      });
    }
    await ok("PATCH", `/api/documents/${document.id}`, agent.as, { baseVersion: 1, body: "Two." });

    const client = await connect(agent.secret);
    const created = await tool(client, "create_document", { title: "Notes" });
    expect(created.isError).toBe(true);
    expect(created.text).toContain("read_access");
  });

  test("None puts the Workspace's own knowledge out of Agents' reach", async () => {
    const { handbook, bea, agent, setWorkspaceAgentAccess } = await beaAtWork();
    await setWorkspaceAgentAccess("none");

    expect((await call("GET", `/api/documents/${handbook.id}`, agent.as)).status).toBe(404);
    expect((await call("GET", `/api/documents/${handbook.id}`, bea)).status).toBe(200);
  });
});

describe("the least-of rule", () => {
  test("an Agent with Write by Agent Access has no more than its Owner's Read", async () => {
    const { project, ticket, bea, agent, ada } = await beaAtWork();
    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "open", users: [{ userId: bea.id, level: "read" }] });

    expect((await call("GET", `/api/tickets/${ticket.id}`, agent.as)).status).toBe(200);
    const refused = await call("POST", `/api/tickets/${ticket.id}/comments`, agent.as, { body: "Mine." });
    expect(refused.json.error.code).toBe("read_access");
  });

  test("a read-only token stays refused whatever the Agent Access", async () => {
    const { ticket, agent } = await beaAtWork();

    expect((await call("GET", `/api/tickets/${ticket.id}`, agent.reader)).status).toBe(200);
    const refused = await call("POST", `/api/tickets/${ticket.id}/comments`, agent.reader, { body: "Mine." });
    expect(refused.status).toBe(403);
    expect((await call("GET", `/api/projects/${ticket.projectId}`, agent.reader)).json.access).toBe("read");
  });

  test("a Project tells an Agent its own Access", async () => {
    const { project, agent, setAgentAccess } = await beaAtWork();
    expect((await ok("GET", `/api/projects/${project.id}`, agent.as)).access).toBe("write");
    await setAgentAccess("read");
    expect((await ok("GET", `/api/projects/${project.id}`, agent.as)).access).toBe("read");
  });
});

describe("Delegation needs Write", () => {
  test.each(["read", "none"] as const)("delegating to an Agent in a Project with Agent Access %s is refused", async (level) => {
    const { own, bea, agent, setAgentAccess } = await beaAtWork();
    await setAgentAccess(level);

    const refused = await call("PATCH", `/api/tickets/${own.id}`, bea, { delegateId: agent.id });
    expect(refused).toEqual({
      status: 400,
      json: {
        error: {
          code: "delegate_cannot_write",
          message: "bea-claude doesn't have Write in this Project, so it can't be delegated its Ticket.",
          rule: expect.stringContaining("Write"),
          advice: expect.stringContaining("Agent Access"),
        },
      },
    });
    expect((await ok("GET", `/api/tickets/${own.id}`, bea)).delegateId).toBeNull();
  });

  test("a Project whose new Tickets start delegated leaves them undelegated while Agents can't write", async () => {
    const { project, bea, ada, setAgentAccess } = await beaAtWork();
    await ok("PATCH", `/api/projects/${project.id}`, ada, { newTicketsDelegated: true });
    await setAgentAccess("read");

    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, bea, { title: "New" });
    expect(ticket).toMatchObject({ assigneeId: null, delegateId: null });
  });
});

describe("dropping a Project's Agent Access below Write", () => {
  test.each(["read", "none"] as const)("to %s undelegates its Tickets and stops their Runs, as the Admin's Changes", async (level) => {
    const { ada, bea, agent, ticket, run, setAgentAccess } = await beaAtWork();

    await setAgentAccess(level);

    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ assigneeId: bea.id, delegateId: null });
    const [stopped] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(stopped).toMatchObject({ id: run.id, state: "stopped", endReason: "ada@example.com removed Agents' Write in CRONK." });
    expect(cronk.runner.stops.map((s) => s.runId)).toEqual([run.id]);
    const changes = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(changes.at(-1)).toMatchObject({
      actor: { kind: "user", id: ada.id, name: "ada@example.com" },
      field: "delegate",
      from: { id: agent.id, name: "bea-claude" },
      to: null,
    });
  });

  test("leaves Tickets in other Projects as they were", async () => {
    const { ada, agent, elsewhere, otherRun, setAgentAccess } = await beaAtWork();

    await setAgentAccess("read");

    expect((await ok("GET", `/api/tickets/${elsewhere.id}`, ada)).delegateId).toBe(agent.id);
    const [run] = await ok("GET", `/api/tickets/${elsewhere.id}/runs`, ada);
    expect(run).toMatchObject({ id: otherRun.id, state: "running" });
  });

  test("puts each Ticket in its Assignee's Inbox until it is moved, reassigned or delegated", async () => {
    const { project, status, ada, bea, ticket, setAgentAccess, inbox } = await beaAtWork();
    cronk.clock.advance(hours(2));

    await setAgentAccess("read");

    expect(await inbox(bea)).toEqual({
      count: 1,
      items: [{ kind: "undelegated", ticket: expect.objectContaining({ id: ticket.id }), since: "2026-01-01T11:00:00.000Z" }],
    });
    expect((await inbox(ada)).items).toEqual([]);
    await ok("PATCH", `/api/tickets/${ticket.id}`, bea, { priority: "high" });
    expect((await inbox(bea)).count).toBe(1);
    await ok("PATCH", `/api/tickets/${ticket.id}`, bea, { statusId: status(project, "Backlog") });
    expect(await inbox(bea)).toEqual({ count: 0, items: [] });
  });

  test("a preview first says how many Tickets it would undelegate, counting each once, changing nothing", async () => {
    const { ada, bea, ticket, run, preview, setAgentAccess } = await beaAtWork();
    const read: ProjectAccess = { visibility: "open", users: [], agentAccess: "read" };

    expect(await preview(read)).toEqual({ status: 200, json: { tickets: 1 } });
    // Bea losing Write too touches CRONK-1 once, and her own CRONK-2.
    expect(await preview({ ...read, users: [{ userId: bea.id, level: "read" }] })).toEqual({ status: 200, json: { tickets: 2 } });
    expect(await preview({ ...read, agentAccess: "write" })).toEqual({ status: 200, json: { tickets: 0 } });
    expect((await ok("GET", `/api/tickets/${ticket.id}/runs`, ada))[0]).toMatchObject({ id: run.id, state: "running" });

    await setAgentAccess("read");
    expect(await preview({ ...read, agentAccess: "none" })).toEqual({ status: 200, json: { tickets: 0 } });
  });

  test("raising it back to Write changes no Ticket", async () => {
    const { ada, bea, agent, own, setAgentAccess } = await beaAtWork();
    await setAgentAccess("read");
    await setAgentAccess("write");

    await ok("PATCH", `/api/tickets/${own.id}`, bea, { delegateId: agent.id });
    expect((await ok("GET", `/api/tickets/${own.id}`, ada)).delegateId).toBe(agent.id);
  });
});

describe("the MCP server's instructions", () => {
  test("describe Access and Agent Access", async () => {
    const { agent } = await beaAtWork();
    const client = await connect(agent.secret);

    const instructions = client.getInstructions()!;
    expect(instructions).toContain("Agent Access");
    expect(instructions).toContain("answers as not found");
    expect(instructions).toContain("`read_access`");
  });
});
