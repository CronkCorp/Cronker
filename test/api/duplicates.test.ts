import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Closing a Ticket as a duplicate of another (CRONK-177): a `duplicateOf` Relation on the duplicate, `duplicatedBy`
 * on the original, and a move to Canceled, which only Users and Full tokens make.
 */

let cronk: StartedCronk;
const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await cronk?.stop();
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

const bearer = (secret: string): Request => ({ headers: { authorization: `Bearer ${secret}` } });
const refusal = (response: { status: number; json: { error: { code: string } } }) => [response.status, response.json.error.code];

/**
 * Ada with a Project on the default board, Tickets CRONK-1 to CRONK-3 in Backlog, and her Agent `claude-max` on her
 * fake Runner, with a Write and a Full token.
 */
async function adaWithTickets() {
  cronk = await startCronk();
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const tickets = [];
  for (const title of ["Dark mode", "Night theme", "Theme picker"]) {
    tickets.push(await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title }));
  }
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const write = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
  const full = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const [original, duplicate, other] = tickets;
  return { ada, project, original, duplicate, other, agent, asWrite: bearer(write.secret), asFull: bearer(full.secret), fullSecret: full.secret as string, status };
}

const ref = (ticket: { id: string; key: string; title: string; projectId: string }) => ({
  id: ticket.id,
  projectId: ticket.projectId,
  key: ticket.key,
  title: ticket.title,
});

const relationsOf = async (ticketId: string, as: Request) =>
  ((await ok("GET", `/api/tickets/${ticketId}/relations`, as)) as { relations: { id: string; kind: string; ticket: { key: string } }[] }).relations;

describe("closing a Ticket as a duplicate", () => {
  test("moves it to Canceled, stopping its Run, and links it to its original both ways", async () => {
    const { ada, original, duplicate, agent, status } = await adaWithTickets();
    await ok("PATCH", `/api/tickets/${duplicate.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await ok("GET", `/api/tickets/${duplicate.id}/runs`, ada);
    expect(run.state).toBe("running");

    const closed = await ok("POST", `/api/tickets/${duplicate.id}/duplicate`, ada, { ticketKey: "cronk-1" });

    expect(closed).toMatchObject({ id: duplicate.id, statusId: status("Canceled") });
    const [stopped] = await ok("GET", `/api/tickets/${duplicate.id}/runs`, ada);
    expect(stopped).toMatchObject({ id: run.id, state: "stopped" });
    const [relation] = await relationsOf(duplicate.id, ada);
    expect(relation).toEqual({ id: expect.any(String), kind: "duplicateOf", ticket: ref(original) });
    expect(await relationsOf(original.id, ada)).toEqual([{ id: relation!.id, kind: "duplicatedBy", ticket: ref(duplicate) }]);
    const timeline = (await ok("GET", `/api/tickets/${duplicate.id}/timeline`, ada)) as { field: string; to: unknown }[];
    expect(timeline.filter((c) => c.field === "duplicateOf" || c.field === "status").map((c) => c.field)).toEqual([
      "status",
      "duplicateOf",
      "status",
    ]);
    const originalTimeline = (await ok("GET", `/api/tickets/${original.id}/timeline`, ada)) as { field: string; to: unknown }[];
    expect(originalTimeline.find((c) => c.field === "duplicatedBy")?.to).toEqual(ref(duplicate));
  });

  test("a duplicate-closed blocker no longer blocks", async () => {
    const { ada, duplicate, other } = await adaWithTickets();
    await ok("POST", `/api/tickets/${duplicate.id}/relations`, ada, { kind: "blocks", ticketId: other.id });
    expect((await ok("GET", `/api/tickets/${other.id}`, ada)).blockedBy).toHaveLength(1);

    await ok("POST", `/api/tickets/${duplicate.id}/duplicate`, ada, { ticketKey: "CRONK-1" });

    expect((await ok("GET", `/api/tickets/${other.id}`, ada)).blockedBy).toEqual([]);
  });

  test("removing the Relation leaves the Ticket Canceled", async () => {
    const { ada, original, duplicate, status } = await adaWithTickets();
    await ok("POST", `/api/tickets/${duplicate.id}/duplicate`, ada, { ticketId: original.id });
    const [relation] = await relationsOf(duplicate.id, ada);

    await ok("DELETE", `/api/tickets/${original.id}/relations/${relation!.id}`, ada);

    expect(await relationsOf(duplicate.id, ada)).toEqual([]);
    expect((await ok("GET", `/api/tickets/${duplicate.id}`, ada)).statusId).toBe(status("Canceled"));
  });

  test("is refused for the Ticket itself, a finished Ticket, an original that is a duplicate and an unknown Ticket", async () => {
    const { ada, original, duplicate, other, status } = await adaWithTickets();
    expect(refusal(await call("POST", `/api/tickets/${duplicate.id}/duplicate`, ada, { ticketKey: "CRONK-2" }))).toEqual([
      400,
      "relation_to_itself",
    ]);
    expect(refusal(await call("POST", `/api/tickets/${duplicate.id}/duplicate`, ada, { ticketKey: "CRONK-99" }))).toEqual([
      400,
      "unknown_ticket",
    ]);

    await ok("POST", `/api/tickets/${duplicate.id}/duplicate`, ada, { ticketKey: "CRONK-1" });
    // CRONK-2 is now closed: closing it again, or the original as its duplicate, is refused.
    expect(refusal(await call("POST", `/api/tickets/${duplicate.id}/duplicate`, ada, { ticketKey: "CRONK-3" }))).toEqual([
      409,
      "ticket_finished",
    ]);
    const viaDuplicate = await call("POST", `/api/tickets/${other.id}/duplicate`, ada, { ticketKey: "CRONK-2" });
    expect(refusal(viaDuplicate)).toEqual([400, "original_is_duplicate"]);
    expect(viaDuplicate.json.error.advice).toContain("CRONK-1");
    const cycle = await call("POST", `/api/tickets/${original.id}/duplicate`, ada, { ticketKey: "CRONK-2" });
    expect(refusal(cycle)).toEqual([400, "original_is_duplicate"]);

    await ok("PATCH", `/api/tickets/${other.id}`, ada, { statusId: status("Done") });
    expect(refusal(await call("POST", `/api/tickets/${other.id}/duplicate`, ada, { ticketKey: "CRONK-1" }))).toEqual([
      409,
      "ticket_finished",
    ]);
    expect((await ok("GET", `/api/tickets/${original.id}`, ada)).statusId).toBe(status("Backlog"));
  });

  test("the relate route doesn't make a duplicate", async () => {
    const { ada, original, duplicate } = await adaWithTickets();
    const response = await call("POST", `/api/tickets/${duplicate.id}/relations`, ada, { kind: "duplicateOf", ticketId: original.id });
    expect(response.status).toBe(400);
    expect(await relationsOf(duplicate.id, ada)).toEqual([]);
  });
});

describe("an Agent closing a Ticket as a duplicate", () => {
  test("is refused with a Write token, leaving both Tickets as they were", async () => {
    const { ada, duplicate, asWrite, status } = await adaWithTickets();

    const refused = await call("POST", `/api/tickets/${duplicate.id}/duplicate`, asWrite, { ticketKey: "CRONK-1" });

    expect(refusal(refused)).toEqual([403, "full_token_needed"]);
    expect((await ok("GET", `/api/tickets/${duplicate.id}`, ada)).statusId).toBe(status("Backlog"));
    expect(await relationsOf(duplicate.id, ada)).toEqual([]);
  });

  test("closes it with a Full token, as a Change by the Agent with no Run, over HTTP and MCP", async () => {
    const { ada, duplicate, other, asFull, fullSecret, status } = await adaWithTickets();

    await ok("POST", `/api/tickets/${duplicate.id}/duplicate`, asFull, { ticketKey: "CRONK-1" });

    const timeline = (await ok("GET", `/api/tickets/${duplicate.id}/timeline`, ada)) as {
      field: string;
      actor: { name: string };
      runId: string | null;
    }[];
    expect(timeline.filter((c) => c.field === "duplicateOf" || c.field === "status").map((c) => [c.field, c.actor.name, c.runId])).toEqual([
      ["duplicateOf", "claude-max", null],
      ["status", "claude-max", null],
    ]);

    const client = new Client({ name: "cronk-test", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", cronk.url), { requestInit: { headers: { authorization: `Bearer ${fullSecret}` } } }),
    );
    clients.push(client);
    const result = await client.callTool({ name: "close_as_duplicate", arguments: { ticket: "CRONK-3", original: "CRONK-1" } });
    expect(result.isError ?? false).toBe(false);
    expect((await ok("GET", `/api/tickets/${other.id}`, ada)).statusId).toBe(status("Canceled"));
    expect((await relationsOf(other.id, ada)).map((r) => [r.kind, r.ticket.key])).toEqual([["duplicateOf", "CRONK-1"]]);
  });
});
