import { afterEach, describe, expect, test } from "vitest";
import { minutes } from "../harness/clock.js";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Reopen and the Tickets it blocks: Reopening an Unverified completion lists the Tickets it blocks that moved on since
 * it was completed, and Cronk tells each of them, quoting the reason.
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

/**
 * Ada's CRONK-1 under Autonomous Delegation in Code review, with its Run running on her fake Runner, and Grace, a
 * member who isn't an Admin. `dependent()` files a Ticket CRONK-1 blocks.
 */
async function blockerInCodeReview() {
  cronk = await startCronk();
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Lay the ground" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: true, delegateId: agent.id });
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Code review") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const dependent = async (title: string, projectId = project.id) => {
    const filed = await ok("POST", `/api/projects/${projectId}/tickets`, ada, { title });
    await ok("POST", `/api/tickets/${ticket.id}/relations`, ada, { kind: "blocks", ticketId: filed.id });
    return filed;
  };
  const complete = async () => {
    cronk.clock.advance(minutes(1));
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "complete" });
    cronk.clock.advance(minutes(1));
  };
  return { workspace, ada, grace: { ...grace, as: { cookie: grace.cookie } }, project, ticket, agent, status, dependent, complete };
}

const keysOf = (preview: { dependents: { ticket: { key: string } }[] }) => preview.dependents.map((d) => d.ticket.key);

describe("Reopen's preview of the dependents that moved on", () => {
  test("lists the Tickets it blocks that left a Backlog Status, or had a Run start, since it was completed", async () => {
    const { ada, ticket, agent, status, dependent, complete } = await blockerInCodeReview();
    const leftBacklog = await dependent("Leaves Backlog after"); // CRONK-2
    const ranAfter = await dependent("Gets a Run after"); // CRONK-3
    const stayed = await dependent("Stays in Backlog"); // CRONK-4
    const movedBefore = await dependent("Moved before"); // CRONK-5
    const waiting = await dependent("Waits for it"); // CRONK-6
    await ok("PATCH", `/api/tickets/${ranAfter.id}`, ada, { delegateId: agent.id });
    await ok("PATCH", `/api/tickets/${movedBefore.id}`, ada, { statusId: status("Triage") });
    // Delegated in a Step's Status while blocked, it waits, and its Run starts the moment CRONK-1 is completed.
    await ok("PATCH", `/api/tickets/${waiting.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });
    expect((await ok("GET", `/api/tickets/${ticket.id}/reopen-preview`, ada)).dependents).toEqual([]);

    await complete();
    await ok("PATCH", `/api/tickets/${leftBacklog.id}`, ada, { statusId: status("Ready") }); // Backlog to Backlog: not yet
    await ok("PATCH", `/api/tickets/${movedBefore.id}`, ada, { statusId: status("Merge") }); // out of an active Status
    expect(keysOf(await ok("GET", `/api/tickets/${ticket.id}/reopen-preview`, ada))).toEqual(
      expect.not.arrayContaining(["CRONK-2", "CRONK-5"]),
    );
    await ok("PATCH", `/api/tickets/${leftBacklog.id}`, ada, { statusId: status("Merge") });
    await ok("PATCH", `/api/tickets/${ranAfter.id}`, ada, { statusId: status("Implement") });

    const preview = await ok("GET", `/api/tickets/${ticket.id}/reopen-preview`, ada);

    expect(preview.dependents).toEqual([
      {
        ticket: { id: leftBacklog.id, projectId: ticket.projectId, key: "CRONK-2", title: "Leaves Backlog after" },
        status: { id: status("Merge"), name: "Merge", kind: "active" },
        running: false,
      },
      {
        ticket: { id: ranAfter.id, projectId: ticket.projectId, key: "CRONK-3", title: "Gets a Run after" },
        status: { id: status("Implement"), name: "Implement", kind: "active" },
        running: true,
      },
      {
        ticket: { id: waiting.id, projectId: ticket.projectId, key: "CRONK-6", title: "Waits for it" },
        status: { id: status("Investigate"), name: "Investigate", kind: "active" },
        running: true,
      },
    ]);
    expect(keysOf(preview)).not.toContain(stayed.key);
  });

  test("leaves out what the User can't read, and is empty for a Ticket that isn't Unverified", async () => {
    const { workspace, ada, grace, ticket, status, dependent, complete } = await blockerInCodeReview();
    const hidden = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Secret", key: "SECRET" });
    await ok("PUT", `/api/projects/${hidden.id}/access`, ada, { visibility: "private", users: [] });
    const secret = await dependent("Hidden", hidden.id);
    const open = await dependent("Open");
    await complete();
    const triage = hidden.statuses.find((s: { name: string }) => s.name === "Triage").id;
    await ok("PATCH", `/api/tickets/${secret.id}`, ada, { statusId: triage });
    await ok("PATCH", `/api/tickets/${open.id}`, ada, { statusId: status("Triage") });

    expect(keysOf(await ok("GET", `/api/tickets/${ticket.id}/reopen-preview`, ada))).toEqual(["CRONK-2", "SECRET-1"]);
    expect(keysOf(await ok("GET", `/api/tickets/${ticket.id}/reopen-preview`, grace.as))).toEqual(["CRONK-2"]);
    expect((await ok("GET", `/api/tickets/${open.id}/reopen-preview`, ada)).dependents).toEqual([]);
    expect((await call("GET", `/api/tickets/${secret.id}/reopen-preview`, grace.as)).status).toBe(404);
  });
});

describe("Reopening with dependents that moved on", () => {
  test("Cronk writes one Comment on each, naming the reopened Ticket and quoting the reason", async () => {
    const { ada, ticket, status, dependent, complete } = await blockerInCodeReview();
    const moved = await dependent("Moved on");
    const stayed = await dependent("Stayed");
    await complete();
    await ok("PATCH", `/api/tickets/${moved.id}`, ada, { statusId: status("Triage") });

    await ok("POST", `/api/tickets/${ticket.id}/reopen`, ada, { comment: "The tests don't pass.\n\nSee the log." });

    const comments = await ok("GET", `/api/tickets/${moved.id}/comments`, ada);
    expect(comments).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ kind: "cronk" }),
        body:
          "CRONK-1, which blocks this Ticket, was Reopened after this one moved on, so the work this one builds on may change:\n\n" +
          "> The tests don't pass.\n>\n> See the log.",
      }),
    ]);
    expect(await ok("GET", `/api/tickets/${stayed.id}/comments`, ada)).toEqual([]);
    // The Comment mentions the reopened Ticket, so it shows where CRONK-1 is mentioned.
    const reopened = await ok("GET", `/api/tickets/${ticket.id}`, ada);
    expect(reopened.mentionedIn).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "comment", ticket: expect.objectContaining({ key: "CRONK-2" }) })]),
    );
    // Once Reopened, it isn't Unverified, so nothing more is listed.
    expect((await ok("GET", `/api/tickets/${ticket.id}/reopen-preview`, ada)).dependents).toEqual([]);
  });

  test("a dependent the reopening User can't read gets no Comment", async () => {
    const { workspace, ada, grace, ticket, status, dependent, complete } = await blockerInCodeReview();
    const hidden = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Secret", key: "SECRET" });
    await ok("PUT", `/api/projects/${hidden.id}/access`, ada, { visibility: "private", users: [] });
    const secret = await dependent("Hidden", hidden.id);
    const open = await dependent("Open");
    await complete();
    await ok("PATCH", `/api/tickets/${secret.id}`, ada, { statusId: hidden.statuses.find((s: { name: string }) => s.name === "Triage").id });
    await ok("PATCH", `/api/tickets/${open.id}`, ada, { statusId: status("Triage") });

    await ok("POST", `/api/tickets/${ticket.id}/reopen`, grace.as, { comment: "Not done." });

    expect(await ok("GET", `/api/tickets/${secret.id}/comments`, ada)).toEqual([]);
    expect(await ok("GET", `/api/tickets/${open.id}/comments`, ada)).toHaveLength(1);
  });

  test("with none, Reopen writes no Comment but its own", async () => {
    const { ada, ticket, dependent, complete } = await blockerInCodeReview();
    const stayed = await dependent("Stayed");
    await complete();

    await ok("POST", `/api/tickets/${ticket.id}/reopen`, ada, { comment: "Again." });

    expect(await ok("GET", `/api/tickets/${stayed.id}/comments`, ada)).toEqual([]);
    expect((await ok("GET", `/api/tickets/${ticket.id}/comments`, ada)).map((c: { body: string }) => c.body)).toEqual(["Again."]);
  });
});
