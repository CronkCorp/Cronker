import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

// ADR 0005: merging is a Step of its own, skipped unless an agent may merge.

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
 * Ada, an Admin, with a Project on the default board, a Ticket in Backlog, and her Agent `claude-max`
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

const runsOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}/runs`, as);

describe("the agents may merge setting", () => {
  test("is off on a new Project, and an Admin turns it on and off", async () => {
    const { ada, project } = await adaWithAgent();
    expect(project.agentsMayMerge).toBe(false);

    expect(await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: true })).toMatchObject({ agentsMayMerge: true });
    expect(await ok("GET", `/api/projects/${project.id}`, ada)).toMatchObject({ agentsMayMerge: true });

    expect(await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: false })).toMatchObject({ agentsMayMerge: false });
  });

  test("a member who isn't an Admin is refused it, and nothing changes; their other settings still save", async () => {
    const { ada, workspace, project } = await adaWithAgent();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");

    const refused = await call("PATCH", `/api/projects/${project.id}`, bea, { agentsMayMerge: true, newTicketsDelegated: true });
    expect(refused).toEqual({
      status: 403,
      json: { error: { code: "not_admin", message: "Only an Admin of this Workspace can change whether agents may merge." } },
    });
    expect(await ok("GET", `/api/projects/${project.id}`, ada)).toMatchObject({ agentsMayMerge: false, newTicketsDelegated: false });

    expect(await ok("PATCH", `/api/projects/${project.id}`, bea, { newTicketsDelegated: true })).toMatchObject({
      newTicketsDelegated: true,
    });
  });

  test("an Agent can't change it", async () => {
    const { asAgent, project } = await adaWithAgent();

    const refused = await call("PATCH", `/api/projects/${project.id}`, asAgent, { agentsMayMerge: true });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("agent_not_allowed");
  });
});

/** Adds a Status called Ship it after Code review, with a Merge Step passing Tickets on to In Review, and returns the Project. */
async function addMergeStatus(setup: Awaited<ReturnType<typeof adaWithAgent>>, name = "Ship it") {
  const { ada, project, status } = setup;
  const position = project.statuses.findIndex((s: { name: string }) => s.name === "In Review");
  const added = await ok("POST", `/api/projects/${project.id}/statuses`, ada, { name, kind: "active", position });
  const id = added.statuses.find((s: { name: string }) => s.name === name).id as string;
  const changed = await ok("PUT", `/api/projects/${project.id}/statuses/${id}/step`, ada, {
    kind: "merge",
    brief: "Merge the Pull Request.",
    model: "haiku",
    outcomes: [
      { name: "review", statusId: status("In Review"), default: true, needsYou: false, countsAsRound: false },
      { name: "conflict", statusId: status("Implement"), default: false, needsYou: false, countsAsRound: true },
      { name: "needs you", statusId: status("In Review"), default: false, needsYou: true, countsAsRound: false },
    ],
  });
  return { project: changed, id };
}

describe("a Project's own Merge Step", () => {
  test("a Status of the Project's own takes a Merge Step; a Step given no kind is an ordinary one", async () => {
    const setup = await adaWithAgent();
    const { ada, project, status } = setup;

    const { project: changed, id } = await addMergeStatus(setup);

    const shipIt = changed.statuses.find((s: { id: string }) => s.id === id);
    expect(shipIt.step).toMatchObject({ kind: "merge", model: "haiku" });
    expect((await ok("GET", `/api/projects/${project.id}`, ada)).statuses.find((s: { id: string }) => s.id === id).step.kind).toBe(
      "merge",
    );
    const triage = changed.statuses.find((s: { id: string }) => s.id === status("Triage"));
    const { kind: _, ...withoutKind } = triage.step;
    const rewritten = await ok("PUT", `/api/projects/${project.id}/statuses/${status("Triage")}/step`, ada, withoutKind);
    expect(rewritten.statuses.find((s: { id: string }) => s.id === status("Triage")).step.kind).toBe("ordinary");
  });
});

describe("the Merge Step skips itself unless an agent may merge", () => {
  /** Ada's delegated Ticket, on a board with her own Merge Status, Ship it, between Code review and In Review. */
  async function delegatedNextToMerge({ autonomous, agentsMayMerge }: { autonomous: boolean; agentsMayMerge: boolean }) {
    const setup = await adaWithAgent();
    const { ada, project, ticket, agent } = setup;
    const { id: shipIt } = await addMergeStatus(setup);
    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: autonomous });
    return { ...setup, shipIt };
  }

  /** The Changes Cronk recorded on the Ticket, with what they changed. */
  async function cronksChanges(ticketId: string, as: Request) {
    const timeline = await ok("GET", `/api/tickets/${ticketId}/timeline`, as);
    return timeline
      .filter((c: { actor: { kind: string } }) => c.actor.kind === "cronk")
      .map(({ field, from, to }: { field: string; from: unknown; to: unknown }) => ({ field, from, to }));
  }

  test("without Autonomous Delegation, a Ticket entering it is passed on to In Review by its default Outcome, as Cronk's Change", async () => {
    const { ada, ticket, status, shipIt } = await delegatedNextToMerge({ autonomous: false, agentsMayMerge: true });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: shipIt });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("In Review"));
    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect(cronk.runner.starts).toEqual([]);
    expect(await cronksChanges(ticket.id, ada)).toEqual([
      {
        field: "stepSkipped",
        from: null,
        to: { status: { id: shipIt, name: "Ship it" }, labelRule: null, mergeRule: "noAutonomousDelegation", outcome: "review" },
      },
      { field: "status", from: { id: shipIt, name: "Ship it" }, to: { id: status("In Review"), name: "In Review" } },
    ]);
  });

  test("in a Project with agents may merge off, even an Autonomous Delegation Ticket is passed on to In Review", async () => {
    const { ada, ticket, status, shipIt } = await delegatedNextToMerge({ autonomous: true, agentsMayMerge: false });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: shipIt });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("In Review"));
    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect(await cronksChanges(ticket.id, ada)).toEqual([
      {
        field: "stepSkipped",
        from: null,
        to: { status: { id: shipIt, name: "Ship it" }, labelRule: null, mergeRule: "agentsMayMergeOff", outcome: "review" },
      },
      { field: "status", from: { id: shipIt, name: "Ship it" }, to: { id: status("In Review"), name: "In Review" } },
    ]);
  });

  test("with Autonomous Delegation and agents may merge on, the Ticket gets a Run on the Merge Step's model", async () => {
    const { ada, ticket, shipIt } = await delegatedNextToMerge({ autonomous: true, agentsMayMerge: true });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: shipIt });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(shipIt);
    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { step: { name: string }; state: string }) => [r.step.name, r.state])).toEqual([["Ship it", "running"]]);
    expect(cronk.runner.starts.map((s) => s.model)).toEqual(["haiku"]);
    expect(await cronksChanges(ticket.id, ada)).toEqual([]);
  });
});

describe("Merge on the default board", () => {
  test("a new Project's board has Merge, an Active Status with a Merge Step on Haiku, between Code review and In Review", async () => {
    const { project, status } = await adaWithAgent();

    expect(project.statuses.map((s: { name: string; kind: string }) => [s.name, s.kind])).toEqual([
      ["Backlog", "backlog"],
      ["Triage", "active"],
      ["Ready", "backlog"],
      ["Investigate", "active"],
      ["Implement", "active"],
      ["Code review", "active"],
      ["Merge", "active"],
      ["In Review", "review"],
      ["Done", "done"],
      ["Canceled", "canceled"],
    ]);
    const merge = project.statuses.find((s: { name: string }) => s.name === "Merge");
    expect(merge.step).toMatchObject({
      kind: "merge",
      model: "haiku",
      labelRule: null,
      outcomes: [
        { name: "review", statusId: status("In Review"), default: true, needsYou: false, countsAsRound: false },
        { name: "send back", statusId: status("Implement"), default: false, needsYou: false, countsAsRound: true },
        { name: "needs you", statusId: status("In Review"), default: false, needsYou: true, countsAsRound: false },
      ],
    });
    const codeReview = project.statuses.find((s: { name: string }) => s.name === "Code review");
    expect(codeReview.step.outcomes.find((o: { name: string }) => o.name === "approve").statusId).toBe(status("Merge"));
    expect(project.statuses.filter((s: { step: { kind: string } | null }) => s.step?.kind === "merge")).toHaveLength(1);
  });

  test("a Ticket Code review approves passes through Merge on to In Review, with no Run there, while agents may not merge", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Code review") });
    const [run] = await runsOf(ticket.id, ada);

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "approve" });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("In Review"));
    expect((await runsOf(ticket.id, ada)).map((r: { step: { name: string } }) => r.step.name)).toEqual(["Code review"]);
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.find((c: { field: string }) => c.field === "stepSkipped")).toMatchObject({
      actor: { kind: "cronk", name: "Cronk" },
      to: { status: { id: status("Merge"), name: "Merge" }, labelRule: null, mergeRule: "agentsMayMergeOff", outcome: "review" },
    });
  });

  test("an existing Project's board is left as it was: no Merge Status, its Steps ordinary, agents may merge off", async () => {
    await cronk.stop();
    cronk = await startCronk({ migrateBefore: "0033_merge_step.sql" });
    // Setting up, as today's API does, gives the Workspace a slug.
    await cronk.applyAhead("0044_workspace_slugs.sql");
    const { workspace } = await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };
    // As a Cronk before the Merge Step wrote a Project with its default board and its Code review Step.
    const projectId = "00000000-0000-4000-8000-000000000001";
    await cronk.stage(
      `insert into projects (id, workspace_id, name, key, created_at) values ($1, $2, 'Cronker', 'CRONK', '2026-01-01T09:00:00Z')`,
      [projectId, workspace.id],
    );
    const board = [
      ["Backlog", "backlog"],
      ["Triage", "active"],
      ["Ready", "backlog"],
      ["Investigate", "active"],
      ["Implement", "active"],
      ["Code review", "active"],
      ["In Review", "review"],
      ["Done", "done"],
      ["Canceled", "canceled"],
    ];
    const statusIds = board.map((_, i) => `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`);
    for (const [position, [name, kind]] of board.entries()) {
      await cronk.stage(
        `insert into statuses (id, workspace_id, project_id, name, kind, position, created_at)
         values ($1, $2, $3, $4, $5, $6, '2026-01-01T09:00:00Z')`,
        [statusIds[position], workspace.id, projectId, name, kind, position],
      );
    }
    const [implement, codeReview, inReview] = [statusIds[4], statusIds[5], statusIds[6]];
    const stepId = "00000000-0000-4000-8000-000000000200";
    await cronk.stage(
      `insert into steps (id, workspace_id, project_id, status_id, brief, model, created_at)
       values ($1, $2, $3, $4, 'Review the pull request.', 'sonnet', '2026-01-01T09:00:00Z')`,
      [stepId, workspace.id, projectId, codeReview],
    );
    await cronk.stage(
      `insert into outcomes (step_id, project_id, position, name, status_id, is_default, needs_you, counts_as_round)
       values ($1, $2, 0, 'approve', $3, true, false, false), ($1, $2, 1, 'needs you', $4, false, true, false)`,
      [stepId, projectId, inReview, implement],
    );

    await cronk.upgrade();

    const project = await ok("GET", `/api/projects/${projectId}`, ada);
    expect(project.agentsMayMerge).toBe(false);
    expect(project.statuses.map((s: { name: string; kind: string }) => [s.name, s.kind])).toEqual(board);
    expect(project.statuses.find((s: { id: string }) => s.id === codeReview).step).toMatchObject({
      kind: "ordinary",
      outcomes: [
        expect.objectContaining({ name: "approve", statusId: inReview }),
        expect.objectContaining({ name: "needs you", statusId: implement }),
      ],
    });
  });
});

describe("changing agents may merge", () => {
  test("turning it off passes on a Ticket waiting in Merge for its Runner, as entering Merge then would", async () => {
    const { ada, project, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: true });
    cronk.runner.refuseNext({ kind: "rate_limited", message: "Too many fires.", retryAt: new Date("2026-01-01T10:00:00Z") });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Merge") });
    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ statusId: status("Merge"), waiting: "runnerPaused" });

    await ok("PATCH", `/api/projects/${project.id}`, ada, { agentsMayMerge: false });

    expect(await ok("GET", `/api/tickets/${ticket.id}`, ada)).toMatchObject({ statusId: status("In Review"), waiting: null });
    expect(await runsOf(ticket.id, ada)).toEqual([]);
  });
});
