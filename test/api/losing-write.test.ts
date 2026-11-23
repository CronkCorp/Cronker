import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Losing Write in a Project, by any Access change, lets go of its Tickets as leaving the Workspace does
 * (`leaving.test.ts`), narrowed to that Project.
 */

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
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

/** A member's Agent `name` in the Workspace, using a fake Runner of theirs, with a Write token. */
async function agentOf(as: Request, workspaceId: string, name: string) {
  const runner = await ok("POST", "/api/runners", as, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspaceId}/agents`, as, { name });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, as, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, as, { name: "cloud", access: "write" });
  return { ...agent, as: { headers: { authorization: `Bearer ${secret}` } } };
}

type Access = { visibility: "open" | "private"; users: { userId: string; level: "write" | "read" }[] };

/**
 * Ada's Workspace with an open Project CRONK on the default board, and Bea as a member with her Agent `bea-claude`,
 * whose Run on Bea's Ticket CRONK-1 is running in Triage; Bea's CRONK-2 waits in Review, in her Inbox. A second
 * Project OTHER holds Bea's Ticket OTHER-1, delegated and running too.
 */
async function beaAtWork() {
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
  const reviewing = await ok("POST", `/api/projects/${project.id}/tickets`, bea, { title: "Bea's review" });
  await ok("PATCH", `/api/tickets/${reviewing.id}`, bea, { assigneeId: bea.id, statusId: status(project, "In Review") });
  const elsewhere = await ok("POST", `/api/projects/${other.id}/tickets`, bea, { title: "Bea's other work" });
  await ok("PATCH", `/api/tickets/${elsewhere.id}`, bea, { delegateId: agent.id, statusId: status(other, "Triage") });
  const [otherRun] = await ok("GET", `/api/tickets/${elsewhere.id}/runs`, ada);
  const setAccess = (access: Access) => ok("PUT", `/api/projects/${project.id}/access`, ada, access);
  const preview = (access: Access, as: Request = ada) => call("POST", `/api/projects/${project.id}/access/preview`, as, access);
  const inbox = (as: Request) => ok("GET", `/api/workspaces/${workspace.id}/inbox`, as);
  return { workspace, project, ada, bea, agent, ticket, run, reviewing, elsewhere, otherRun, setAccess, preview, inbox };
}

type Setting = Awaited<ReturnType<typeof beaAtWork>>;

/** The ways an Access change takes Bea's Write in CRONK away, each from the Access she had Write by. */
const waysOfLosingWrite: { name: string; from: (s: Setting) => Access | null; to: (s: Setting) => Access }[] = [
  {
    name: "dropping her listed level to Read",
    from: ({ bea }) => ({ visibility: "open", users: [{ userId: bea.id, level: "write" }] }),
    to: ({ bea }) => ({ visibility: "open", users: [{ userId: bea.id, level: "read" }] }),
  },
  {
    name: "taking her off a private Project's list",
    from: ({ bea }) => ({ visibility: "private", users: [{ userId: bea.id, level: "write" }] }),
    to: () => ({ visibility: "private", users: [] }),
  },
  {
    name: "making the open Project private without listing her",
    from: () => null,
    to: () => ({ visibility: "private", users: [] }),
  },
];

describe.each(waysOfLosingWrite)("losing Write in a Project by $name", ({ from, to }) => {
  async function losing() {
    const setting = await beaAtWork();
    const start = from(setting);
    if (start) await setting.setAccess(start);
    return { ...setting, lose: () => setting.setAccess(to(setting)), change: to(setting) };
  }

  test("stops her Agents' running Runs there, asking the Runner to stop them too", async () => {
    const { ada, ticket, run, lose } = await losing();
    expect(run.state).toBe("running");

    await lose();

    const [stopped] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(stopped).toMatchObject({
      id: run.id,
      state: "stopped",
      endReason: "ada@example.com removed bea@example.com's Write in CRONK.",
    });
    expect(cronk.runner.stops.map((s) => s.runId)).toEqual([run.id]);
  });

  test("unassigns and undelegates her Tickets there, as the Admin's Changes", async () => {
    const { ada, bea, agent, ticket, reviewing, lose } = await losing();

    await lose();

    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ assigneeId: null, delegateId: null });
    expect(await ok("GET", `/api/tickets/${reviewing.id}`, ada)).toMatchObject({ assigneeId: null });
    const changes = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    const byAda = { kind: "user", id: ada.id, name: "ada@example.com" };
    expect(changes.slice(-2)).toMatchObject([
      { actor: byAda, field: "assignee", from: { id: bea.id, name: "bea@example.com" }, to: null },
      { actor: byAda, field: "delegate", from: { id: agent.id, name: "bea-claude" }, to: null },
    ]);
  });

  test("puts her Tickets there in the Admins' Inbox, and takes her own items from there out of hers", async () => {
    const { workspace, ada, bea, ticket, reviewing, lose, inbox } = await losing();
    const cy = await addMember(cronk, ada.cookie, workspace.id, "cy@example.com");
    await ok("PATCH", `/api/workspaces/${workspace.id}/members/${cy.user.id}`, ada, { isAdmin: true });
    expect((await inbox(bea)).items.map((i: { kind: string; ticket: { key: string } }) => [i.kind, i.ticket.key])).toEqual([
      ["review", "CRONK-2"],
    ]);
    cronk.clock.advance(hours(2));

    await lose();

    const formerAssignee = { id: bea.id, email: "bea@example.com", githubLogin: null, displayName: null };
    const expected = {
      count: 2,
      items: [ticket, reviewing].map((t) => ({
        kind: "reassign",
        ticket: expect.objectContaining({ id: t.id, assigneeId: null }),
        formerAssignee,
        since: "2026-01-01T11:00:00.000Z",
      })),
    };
    expect(await inbox(ada)).toEqual(expected);
    expect(await inbox({ cookie: cy.cookie })).toEqual(expected);
    expect(await inbox(bea)).toEqual({ count: 0, items: [] });
  });

  test("leaves her Tickets in other Projects as they were", async () => {
    const { ada, bea, agent, elsewhere, otherRun, lose } = await losing();

    await lose();

    expect(await ok("GET", `/api/tickets/${elsewhere.id}`, ada)).toMatchObject({ assigneeId: bea.id, delegateId: agent.id });
    const [run] = await ok("GET", `/api/tickets/${elsewhere.id}/runs`, ada);
    expect(run).toMatchObject({ id: otherRun.id, state: "running" });
    expect(cronk.runner.stops.map((s) => s.runId)).not.toContain(otherRun.id);
  });

  test("a preview first says how many Tickets it would unassign or undelegate, changing nothing", async () => {
    const { ada, ticket, run, preview, change, lose } = await losing();

    expect(await preview(change)).toEqual({ status: 200, json: { tickets: 2 } });

    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ assigneeId: expect.any(String) });
    const [still] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(still).toMatchObject({ id: run.id, state: "running" });
    await lose();
    expect(await preview(change)).toEqual({ status: 200, json: { tickets: 0 } });
  });
});

describe("Access changes that keep a User's Write", () => {
  test("touch none of her Tickets, and their preview says so", async () => {
    const { ada, bea, ticket, run, setAccess, preview } = await beaAtWork();
    const changes: Access[] = [
      { visibility: "open", users: [{ userId: bea.id, level: "write" }] },
      { visibility: "private", users: [{ userId: bea.id, level: "write" }] },
      { visibility: "open", users: [] },
    ];

    for (const change of changes) {
      expect(await preview(change)).toEqual({ status: 200, json: { tickets: 0 } });
      await setAccess(change);
    }

    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ assigneeId: bea.id });
    const [still] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(still).toMatchObject({ id: run.id, state: "running" });
    expect(cronk.runner.stops).toEqual([]);
  });

  test("never touch an Admin's Tickets, who keeps Write in every Project", async () => {
    const { ada, project, setAccess, preview } = await beaAtWork();
    const adas = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Ada's work" });
    await ok("PATCH", `/api/tickets/${adas.id}`, ada, { assigneeId: ada.id });
    const change: Access = { visibility: "private", users: [{ userId: ada.id, level: "read" }] };

    expect(await preview(change)).toEqual({ status: 200, json: { tickets: 2 } });
    await setAccess(change);

    expect(await ok("GET", `/api/tickets/${adas.id}`, ada)).toMatchObject({ assigneeId: ada.id });
  });
});

describe("previewing an Access change", () => {
  test("is only for Admins, and refuses what setting it would", async () => {
    const { bea, preview } = await beaAtWork();

    const byBea = await preview({ visibility: "private", users: [] }, bea);
    expect(byBea).toEqual({ status: 403, json: { error: expect.objectContaining({ code: "not_admin" }) } });
    const twice = await preview({
      visibility: "open",
      users: [
        { userId: bea.id, level: "read" },
        { userId: bea.id, level: "write" },
      ],
    });
    expect(twice).toEqual({ status: 400, json: { error: expect.objectContaining({ code: "user_listed_twice" }) } });
  });
});
