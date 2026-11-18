import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

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

/**
 * Ada with a Project on the default board, a Ticket in Backlog, and her Agent `claude-max`
 * using her fake Runner, with a full token.
 */
async function adaWithAgent() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, ticket, agent, asAgent, status };
}

const ticketOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}`, as);

describe("the Autonomous Delegation setting", () => {
  test("a Ticket takes it from its Project when first delegated: off unless the Project changes it", async () => {
    const { ada, project, ticket, agent } = await adaWithAgent();
    expect(project.autonomousDelegationDefault).toBe(false);
    expect(ticket.autonomousDelegation).toBeNull();

    const delegated = await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    expect(delegated.autonomousDelegation).toBe(false);

    const changed = await ok("PATCH", `/api/projects/${project.id}`, ada, { autonomousDelegationDefault: true });
    expect(changed.autonomousDelegationDefault).toBe(true);
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    expect(second.autonomousDelegation).toBeNull();
    expect((await ok("PATCH", `/api/tickets/${second.id}`, ada, { delegateId: agent.id })).autonomousDelegation).toBe(true);

    // Only the first Delegation takes the default: the first Ticket keeps its own setting.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: null });
    expect((await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id })).autonomousDelegation).toBe(false);

    // New Tickets that start delegated take it at once.
    await ok("PATCH", `/api/projects/${project.id}`, ada, { newTicketsDelegated: true });
    const born = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Born delegated" });
    expect(born.autonomousDelegation).toBe(true);
  });

  test("a User sets it on a Ticket, recorded on the timeline; an Agent can't", async () => {
    const { ada, ticket, asAgent } = await adaWithAgent();

    const set = await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: true });
    expect(set.autonomousDelegation).toBe(true);
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.at(-1)).toEqual(
      expect.objectContaining({ field: "autonomousDelegation", from: null, to: true, actor: expect.objectContaining({ kind: "user" }) }),
    );

    const byAgent = await call("PATCH", `/api/tickets/${ticket.id}`, asAgent, { autonomousDelegation: false });
    expect(byAgent.status).toBe(403);
    expect(byAgent.json.error.code).toBe("agent_not_allowed");
    expect((await ticketOf(ticket.id, ada)).autonomousDelegation).toBe(true);
  });

  test("Sub-Tickets take their parent's, including ones made Sub-Tickets later, and follow its changes", async () => {
    const { ada, project, ticket: parent, agent } = await adaWithAgent();
    const child = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Child" });
    const grandchild = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Grandchild" });
    await ok("PATCH", `/api/tickets/${grandchild.id}`, ada, { parentId: child.id });
    await ok("PATCH", `/api/tickets/${child.id}`, ada, { parentId: parent.id });
    await ok("PATCH", `/api/projects/${project.id}`, ada, { autonomousDelegationDefault: true });

    // The parent's first Delegation sets it, and its Sub-Tickets take it.
    await ok("PATCH", `/api/tickets/${parent.id}`, ada, { delegateId: agent.id });
    expect((await ticketOf(child.id, ada)).autonomousDelegation).toBe(true);
    expect((await ticketOf(grandchild.id, ada)).autonomousDelegation).toBe(true);

    await ok("PATCH", `/api/tickets/${parent.id}`, ada, { autonomousDelegation: false });
    expect((await ticketOf(child.id, ada)).autonomousDelegation).toBe(false);
    expect((await ticketOf(grandchild.id, ada)).autonomousDelegation).toBe(false);
    const timeline = await ok("GET", `/api/tickets/${grandchild.id}/timeline`, ada);
    expect(timeline.at(-1)).toEqual(expect.objectContaining({ field: "autonomousDelegation", from: true, to: false }));

    // A Ticket made a Sub-Ticket later takes its new parent's, even over its own.
    const later = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Later" });
    await ok("PATCH", `/api/tickets/${later.id}`, ada, { autonomousDelegation: true });
    const joined = await ok("PATCH", `/api/tickets/${later.id}`, ada, { parentId: child.id });
    expect(joined.autonomousDelegation).toBe(false);
    await ok("PATCH", `/api/tickets/${parent.id}`, ada, { autonomousDelegation: true });
    expect((await ticketOf(later.id, ada)).autonomousDelegation).toBe(true);
  });
});

/** Ada's Ticket under Autonomous Delegation, delegated, with a Run of the Code review Step running. */
async function inCodeReview() {
  const setup = await adaWithAgent();
  const { ada, ticket, agent, status } = setup;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: true, delegateId: agent.id });
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Code review") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  return { ...setup, run };
}

describe("completing a Ticket by an Outcome", () => {
  test("Outcomes to a Done Status are offered, and listed in the Brief, only under Autonomous Delegation", async () => {
    const { ada, ticket, run, status } = await inCodeReview();

    const brief = await ok("GET", `/api/runs/${run.id}/brief`, ada);
    expect(brief.preamble).toContain(
      [
        "- **approve**: moves CRONK-1 to In Review.",
        "- **changes**: moves CRONK-1 to Implement. It counts as a round: after 2, the Step's *needs you* Outcome applies instead.",
        "- **complete**: moves CRONK-1 to Done, completing it as Unverified until its Assignee Accepts or Reopens it.",
        "- **needs you**: moves CRONK-1 to In Review and hands it back to its Assignee. Give a Question saying what you need.",
      ].join("\n"),
    );

    // Turned off, the same Step offers no Outcome to Done, to the Run already running or in the Brief.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: false });
    const preview = await ok("GET", `/api/tickets/${ticket.id}/brief`, ada);
    expect(preview.preamble).not.toContain("**complete**");
    expect(preview.preamble).not.toContain("Unverified");
    expect((await ticketOf(ticket.id, ada)).statusId).toBe(status("Code review"));
  });

  test("choosing one completes the Ticket as Unverified", async () => {
    const { ada, ticket, run, asAgent, status } = await inCodeReview();
    expect((await ticketOf(ticket.id, ada)).verification).toBeNull();

    const finished = await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "complete" });

    expect(finished).toEqual(expect.objectContaining({ state: "finished", outcome: "complete" }));
    const completed = await ticketOf(ticket.id, ada);
    expect(completed).toEqual(expect.objectContaining({ statusId: status("Done"), verification: "unverified" }));
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.slice(-2).map((c: { field: string; actor: { name: string }; to: unknown }) => [c.actor.name, c.field, c.to])).toEqual([
      ["claude-max", "status", { id: status("Done"), name: "Done" }],
      ["claude-max", "verification", "unverified"],
    ]);
  });

  test("without Autonomous Delegation, a Run already running may not choose one", async () => {
    const { ada, ticket, run, asAgent, status } = await inCodeReview();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: false });

    const refused = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "complete" });

    expect(refused.status).toBe(400);
    expect(refused.json.error).toEqual(
      expect.objectContaining({ code: "outcome_not_offered", advice: "Finish with one of these Outcomes: approve, changes, needs you." }),
    );
    expect((await ticketOf(ticket.id, ada)).statusId).toBe(status("Code review"));
  });
});
