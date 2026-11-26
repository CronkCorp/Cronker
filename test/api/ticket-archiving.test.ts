import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Archiving Tickets (CRONK-175): a User archives a Ticket in a Done or Canceled Status, taking it off the board, the
 * Ticket lists, its Release's counts and search, and unarchives it to bring it back as it was. An Agent archives only
 * with a Full token, and a User with Read in the Project not at all.
 */

let cronk: StartedCronk;
afterEach(async () => {
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

const refusal = (response: { status: number; json: { error?: { code: string } } }) => [response.status, response.json.error?.code];
const bearer = (secret: string): Request => ({ headers: { authorization: `Bearer ${secret}` } });

/** Ada with a Project on the default board, Tickets CRONK-1 ("Ship the board") and CRONK-2, and her Agent with a Write and a Full token. */
async function adaWithProject() {
  cronk = await startCronk();
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Ship the board" });
  const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Keep going" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const write = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
  const full = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const listed = async (query = "") =>
    ((await ok("GET", `/api/projects/${project.id}/tickets${query}`, ada)) as { key: string; archived: boolean }[]).map(
      (t) => `${t.key}${t.archived ? " (archived)" : ""}`,
    );
  return { workspace, ada, project, ticket, other, agent, asWrite: bearer(write.secret), asFull: bearer(full.secret), status, listed };
}

describe("archiving a Ticket", () => {
  for (const statusName of ["Done", "Canceled"]) {
    test(`in ${statusName} takes it off the lists, keeps it readable, and unarchiving brings it back as it was`, async () => {
      const { ada, ticket, status, listed } = await adaWithProject();
      await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status(statusName), priority: "high" });

      const archived = await ok("POST", `/api/tickets/${ticket.id}/archive`, ada);

      expect(archived).toMatchObject({ archived: true, statusId: status(statusName), priority: "high" });
      expect(await listed()).toEqual(["CRONK-2"]);
      expect(await listed("?archived=include")).toEqual(["CRONK-2", "CRONK-1 (archived)"]);
      expect(await listed("?archived=only")).toEqual(["CRONK-1 (archived)"]);
      expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ key: "CRONK-1", archived: true });

      const unarchived = await ok("POST", `/api/tickets/${ticket.id}/unarchive`, ada);

      expect(unarchived).toMatchObject({ archived: false, statusId: status(statusName), priority: "high" });
      expect(await listed()).toEqual(["CRONK-2", "CRONK-1"]);
      const changes = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)) as { field: string }[];
      expect(changes.map((c) => c.field).slice(-2)).toEqual(["archived", "unarchived"]);
    });
  }

  test("is refused in any other Status, twice, and unarchiving one that isn't archived", async () => {
    const { ada, ticket, status } = await adaWithProject();
    for (const name of ["Backlog", "Ready", "Code review"]) {
      await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status(name) });
      expect(refusal(await call("POST", `/api/tickets/${ticket.id}/archive`, ada))).toEqual([409, "ticket_not_archivable"]);
    }
    expect(refusal(await call("POST", `/api/tickets/${ticket.id}/unarchive`, ada))).toEqual([409, "ticket_not_archived"]);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Done") });
    await ok("POST", `/api/tickets/${ticket.id}/archive`, ada);
    expect(refusal(await call("POST", `/api/tickets/${ticket.id}/archive`, ada))).toEqual([409, "ticket_already_archived"]);
  });

  test("keeps it in its Status until it is unarchived, and keeps its Relations", async () => {
    const { ada, ticket, other, status } = await adaWithProject();
    await ok("POST", `/api/tickets/${ticket.id}/relations`, ada, { kind: "relatesTo", ticketId: other.id });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Done") });
    await ok("POST", `/api/tickets/${ticket.id}/archive`, ada);

    expect(refusal(await call("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Backlog") }))).toEqual([
      409,
      "ticket_archived",
    ]);
    // Other edits stay open to it.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { labels: ["kept"] });
    const relations = await ok("GET", `/api/tickets/${ticket.id}/relations`, ada);
    expect(relations.relations.map((r: { ticket: { key: string } }) => r.ticket.key)).toEqual(["CRONK-2"]);

    await ok("POST", `/api/tickets/${ticket.id}/unarchive`, ada);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Backlog") });
  });

  test("never touches a running Run", async () => {
    const { ada, ticket, other, agent, status } = await adaWithProject();
    await ok("PATCH", `/api/tickets/${other.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await ok("GET", `/api/tickets/${other.id}/runs`, ada);
    expect(run.state).toBe("running");
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Done") });

    await ok("POST", `/api/tickets/${ticket.id}/archive`, ada);
    await ok("POST", `/api/tickets/${ticket.id}/unarchive`, ada);

    expect(await ok("GET", `/api/tickets/${other.id}/runs`, ada)).toEqual([run]);
    expect(await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).toEqual([]);
  });

  test("leaves it out of its Release's counts", async () => {
    const { ada, project, ticket, other, status } = await adaWithProject();
    await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v1.0.0" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { release: "v1.0.0", statusId: status("Done") });
    await ok("PATCH", `/api/tickets/${other.id}`, ada, { release: "v1.0.0" });

    await ok("POST", `/api/tickets/${ticket.id}/archive`, ada);

    const [release] = await ok("GET", `/api/projects/${project.id}/releases`, ada);
    expect(release).toMatchObject({ openCount: 1, doneCount: 0 });
    expect(release.tickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-2"]);
    expect(refusal(await call("PATCH", `/api/tickets/${ticket.id}`, ada, { release: null }))).toEqual([409, "ticket_archived"]);
  });

  test("leaves it out of search unless archived Tickets are asked for", async () => {
    const { workspace, ada, ticket, status } = await adaWithProject();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Done") });
    await ok("POST", `/api/tickets/${ticket.id}/archive`, ada);
    const found = async (query: string) =>
      ((await ok("GET", `/api/workspaces/${workspace.id}/search?q=board&kinds=ticket${query}`, ada)) as {
        ticketKey: string;
        archived: boolean;
      }[]).map((r) => [r.ticketKey, r.archived]);

    expect(await found("")).toEqual([]);
    expect(await found("&includeArchived=true")).toEqual([["CRONK-1", true]]);
  });

  test("is refused to a User with Read, to an Agent's Write token, and in an archived Project", async () => {
    const { workspace, ada, project, ticket, asWrite, asFull, status } = await adaWithProject();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Done") });
    const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
    await ok("PUT", `/api/projects/${project.id}/access`, ada, { visibility: "open", users: [{ userId: grace.user.id, level: "read" }] });

    expect(refusal(await call("POST", `/api/tickets/${ticket.id}/archive`, { cookie: grace.cookie }))).toEqual([403, "read_access"]);
    expect(refusal(await call("POST", `/api/tickets/${ticket.id}/archive`, asWrite))).toEqual([403, "full_token_needed"]);

    // A Full token archives as its Owner would, a Change by the Agent with no Run.
    expect(await ok("POST", `/api/tickets/${ticket.id}/archive`, asFull)).toMatchObject({ archived: true });
    const changes = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)) as { field: string; runId: string | null; actor: { name: string } }[];
    expect(changes.at(-1)).toMatchObject({ field: "archived", runId: null, actor: { name: "claude-max" } });
    expect(refusal(await call("POST", `/api/tickets/${ticket.id}/unarchive`, asWrite))).toEqual([403, "full_token_needed"]);

    await ok("POST", `/api/projects/${project.id}/archive`, ada);
    expect(refusal(await call("POST", `/api/tickets/${ticket.id}/unarchive`, ada))).toEqual([403, "project_archived"]);
  });

  test("still holds its Status, so the Status isn't removed while it is archived there", async () => {
    const { ada, project, ticket } = await adaWithProject();
    const board = await ok("POST", `/api/projects/${project.id}/statuses`, ada, { name: "Shipped", kind: "done" });
    const shipped = board.statuses.find((s: { name: string }) => s.name === "Shipped").id;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: shipped });
    await ok("POST", `/api/tickets/${ticket.id}/archive`, ada);

    const refused = await call("DELETE", `/api/projects/${project.id}/statuses/${shipped}`, ada);

    expect(refused.json.error).toMatchObject({
      code: "status_has_tickets",
      message: "Shipped holds 1 Ticket, archived. Unarchive it and move it to another Status before removing Shipped.",
    });
  });
});
