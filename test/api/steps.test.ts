import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

interface Status {
  id: string;
  name: string;
  kind: string;
  step: { kind: "ordinary" | "merge"; brief: string; model: string; roundLimit: number; labelRule: LabelRule | null; readOnly: boolean; outcomes: Outcome[] } | null;
}
interface LabelRule {
  kind: "requires" | "skippedBy";
  label: string;
}
interface Outcome {
  name: string;
  statusId: string;
  default: boolean;
  needsYou: boolean;
  countsAsRound: boolean;
}
interface Project {
  id: string;
  workspaceId: string;
  key: string;
  statuses: Status[];
}

/** Ada, signed in, with a new Project on the default board. */
async function projectOnDefaultBoard() {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
    cookie,
    body: { name: "Cronker", key: "CRONK" },
  });
  expect(response.status).toBe(201);
  const project = (await response.json()) as Project;
  const status = (name: string) => project.statuses.find((s) => s.name === name)!;
  return { workspace, cookie, project, status, id: (name: string) => status(name).id };
}

const outcome = (name: string, statusId: string, flags: Partial<Outcome> = {}): Outcome => ({
  name,
  statusId,
  default: false,
  needsYou: false,
  countsAsRound: false,
  ...flags,
});

describe("the default board's Steps", () => {
  test("a new Project has Steps on Triage, Investigate, Implement, Code review and Merge, with their Outcomes", async () => {
    const { project, id } = await projectOnDefaultBoard();

    const steps = Object.fromEntries(
      project.statuses.map((s) => [
        s.name,
        s.step && {
          kind: s.step.kind,
          model: s.step.model,
          roundLimit: s.step.roundLimit,
          labelRule: s.step.labelRule,
          readOnly: s.step.readOnly,
          outcomes: s.step.outcomes,
        },
      ]),
    );
    expect(steps).toEqual({
      Backlog: null,
      Triage: {
        kind: "ordinary",
        model: "haiku",
        roundLimit: 2,
        labelRule: null,
        readOnly: true,
        outcomes: [outcome("ready", id("Ready"), { default: true }), outcome("needs you", id("Backlog"), { needsYou: true })],
      },
      Ready: null,
      Investigate: {
        kind: "ordinary",
        model: "sonnet",
        roundLimit: 2,
        labelRule: null,
        readOnly: true,
        outcomes: [outcome("done", id("Implement"), { default: true }), outcome("needs you", id("Backlog"), { needsYou: true })],
      },
      Implement: {
        kind: "ordinary",
        model: "opus",
        roundLimit: 2,
        labelRule: null,
        readOnly: false,
        outcomes: [outcome("done", id("Code review"), { default: true }), outcome("needs you", id("Ready"), { needsYou: true })],
      },
      "Code review": {
        kind: "ordinary",
        model: "sonnet",
        roundLimit: 2,
        labelRule: { kind: "skippedBy", label: "no-review" },
        readOnly: false,
        outcomes: [
          outcome("approve", id("Merge"), { default: true }),
          outcome("changes", id("Implement"), { countsAsRound: true }),
          outcome("complete", id("Done")),
          outcome("needs you", id("In Review"), { needsYou: true }),
        ],
      },
      Merge: {
        kind: "merge",
        model: "haiku",
        roundLimit: 2,
        labelRule: null,
        readOnly: false,
        outcomes: [
          outcome("review", id("In Review"), { default: true }),
          outcome("resolved", id("Merge")),
          outcome("backported", id("Merge")),
          outcome("send back", id("Implement"), { countsAsRound: true }),
          outcome("needs you", id("In Review"), { needsYou: true }),
        ],
      },
      "In Review": null,
      Done: null,
      Canceled: null,
    });
  });

  test("each default Step comes with a Brief saying what its Run is for", async () => {
    const { status } = await projectOnDefaultBoard();

    expect(status("Triage").step!.brief).toMatch(/triage/i);
    expect(status("Investigate").step!.brief).toMatch(/Report/);
    expect(status("Implement").step!.brief).toMatch(/implement/i);
    expect(status("Code review").step!.brief).toMatch(/review/i);
    expect(status("Merge").step!.brief).toMatch(/merge/i);
  });

  test("the default Implement Brief says to push to the Ticket's open Pull Request rather than open another", async () => {
    const { status } = await projectOnDefaultBoard();

    expect(status("Implement").step!.brief).toContain(
      "If the Ticket already has an open Pull Request, push to its branch instead of opening another.",
    );
  });

  test("an existing Project's Steps on Statuses named Triage or Investigate become read-only, and its other Steps don't", async () => {
    await cronk.stop();
    cronk = await startCronk({ migrateBefore: "0091_read_only_steps.sql" });
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    // As a Cronk before read-only Steps wrote a Project, its Statuses named in any case, each with a Step.
    const projectId = "00000000-0000-4000-8000-000000000001";
    await cronk.stage(
      `insert into projects (id, workspace_id, name, key, created_at) values ($1, $2, 'Cronker', 'CRONK', '2026-01-01T09:00:00Z')`,
      [projectId, workspace.id],
    );
    const board = [
      ["Backlog", "backlog"],
      ["triage", "active"],
      ["INVESTIGATE", "active"],
      ["Implement", "active"],
      ["Done", "done"],
      ["Canceled", "canceled"],
    ];
    const statusId = (position: number) => `00000000-0000-4000-8000-0000000001${String(position).padStart(2, "0")}`;
    for (const [position, [name, kind]] of board.entries()) {
      await cronk.stage(
        `insert into statuses (id, workspace_id, project_id, name, kind, position, created_at)
         values ($1, $2, $3, $4, $5, $6, '2026-01-01T09:00:00Z')`,
        [statusId(position), workspace.id, projectId, name, kind, position],
      );
    }
    for (const [position, [, kind]] of board.entries()) {
      if (kind !== "active") continue;
      const stepId = `00000000-0000-4000-8000-0000000002${String(position).padStart(2, "0")}`;
      await cronk.stage(
        `insert into steps (id, workspace_id, project_id, status_id, brief, model, created_at)
         values ($1, $2, $3, $4, 'Do the work.', 'sonnet', '2026-01-01T09:00:00Z')`,
        [stepId, workspace.id, projectId, statusId(position)],
      );
      await cronk.stage(
        `insert into outcomes (step_id, project_id, position, name, status_id, is_default, needs_you, counts_as_round)
         values ($1, $2, 0, 'done', $3, true, false, false), ($1, $2, 1, 'needs you', $4, false, true, false)`,
        [stepId, projectId, statusId(4), statusId(0)],
      );
    }

    await cronk.upgrade();

    const project = (await (await cronk.request("GET", `/api/projects/${projectId}`, { cookie })).json()) as Project;
    const readOnly = Object.fromEntries(project.statuses.filter((s) => s.step).map((s) => [s.name, s.step!.readOnly]));
    expect(readOnly).toEqual({ triage: true, INVESTIGATE: true, Implement: false });
  });
});

/** A Step for the Ready Status, sending Tickets on to Investigate or back to Backlog. */
function readyStep(id: (name: string) => string) {
  return {
    kind: "ordinary" as const,
    brief: "Plan the work.",
    model: "sonnet",
    roundLimit: 3,
    labelRule: null,
    readOnly: false,
    outcomes: [
      outcome("planned", id("Investigate"), { default: true }),
      outcome("unclear", id("Triage"), { countsAsRound: true }),
      outcome("needs you", id("Backlog"), { needsYou: true }),
    ],
  };
}

describe("attaching, editing and removing a Step", () => {
  test("a Step attached to a Status shows on the Project", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const step = readyStep(id);

    const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, {
      cookie,
      body: step,
    });

    expect(response.status).toBe(200);
    const changed = (await response.json()) as Project;
    expect(changed.statuses.find((s) => s.name === "Ready")!.step).toEqual(step);
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(changed);
  });

  test("a Step's round limit is 2 unless given", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const { roundLimit: _, ...step } = readyStep(id);

    const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, {
      cookie,
      body: step,
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Project).statuses.find((s) => s.name === "Ready")!.step!.roundLimit).toBe(2);
  });

  test("editing a Step replaces its Brief, model, round limit, Label rule, read-only setting and Outcomes", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const edited = {
      kind: "ordinary",
      brief: "Triage, briefly.",
      model: "opus",
      roundLimit: 1,
      labelRule: { kind: "requires", label: "ready-to-go" },
      readOnly: false,
      outcomes: [outcome("go", id("Investigate"), { default: true }), outcome("ask", id("Backlog"), { needsYou: true })],
    };

    const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Triage")}/step`, {
      cookie,
      body: edited,
    });

    expect(response.status).toBe(200);
    const changed = (await response.json()) as Project;
    expect(changed.statuses.find((s) => s.name === "Triage")!.step).toEqual(edited);
  });

  test("a Step is not read-only unless set, and set read-only it says so on the Project", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const { readOnly: _, ...step } = readyStep(id);
    const put = async (body: unknown) => {
      const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, { cookie, body });
      expect(response.status).toBe(200);
      return ((await response.json()) as Project).statuses.find((s) => s.name === "Ready")!.step!.readOnly;
    };

    expect(await put(step)).toBe(false);
    expect(await put({ ...step, readOnly: true })).toBe(true);
    expect(await put({ ...step, readOnly: false })).toBe(false);
  });

  test("a Step has no Label rule unless given, and its Label is kept trimmed", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const { labelRule: _, ...step } = readyStep(id);
    const put = async (body: unknown) => {
      const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, { cookie, body });
      return { status: response.status, json: await response.json() };
    };
    const ready = (p: Project) => p.statuses.find((s) => s.name === "Ready")!.step!.labelRule;

    expect(ready((await put(step)).json)).toBeNull();
    expect(ready((await put({ ...step, labelRule: { kind: "skippedBy", label: "  wip " } })).json)).toEqual({
      kind: "skippedBy",
      label: "wip",
    });
    for (const labelRule of [{ kind: "skippedBy", label: " " }, { kind: "ignores", label: "wip" }, { kind: "requires" }]) {
      expect((await put({ ...step, labelRule })).status, JSON.stringify(labelRule)).toBe(400);
    }
  });

  test("removing a Step leaves its Status as one where Tickets wait for a User", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();

    const response = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id("Investigate")}/step`, {
      cookie,
    });

    expect(response.status).toBe(200);
    const changed = (await response.json()) as Project;
    expect(changed.statuses.find((s) => s.name === "Investigate")).toEqual({
      id: id("Investigate"),
      name: "Investigate",
      kind: "active",
      step: null,
    });
    expect(changed.statuses.find((s) => s.name === "Implement")!.step).not.toBeNull();
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(changed);
  });

  test("a Step goes with its Status", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();

    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id("Investigate")}`, { cookie });
    expect(removed.status).toBe(200);
    const readded = await cronk.request("POST", `/api/projects/${project.id}/statuses`, {
      cookie,
      body: { name: "Investigate", kind: "active", position: 3 },
    });

    expect(((await readded.json()) as Project).statuses[3]).toEqual(expect.objectContaining({ name: "Investigate", step: null }));
  });

  test("a Status not in the Project, or a Project out of view, is not found", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const other = await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } });
    const friends = (await other.json()) as { id: string };
    const elsewhere = (await (
      await cronk.request("POST", `/api/workspaces/${friends.id}/projects`, { cookie, body: { name: "Party", key: "PARTY" } })
    ).json()) as Project;

    for (const [method, path, body] of [
      ["PUT", `/api/projects/${project.id}/statuses/${elsewhere.statuses[1]!.id}/step`, readyStep(id)],
      ["DELETE", `/api/projects/${project.id}/statuses/not-a-status/step`],
      ["PUT", `/api/projects/00000000-0000-0000-0000-000000000000/statuses/${id("Ready")}/step`, readyStep(id)],
    ] as const) {
      const response = await cronk.request(method, path, { cookie, body });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe("Agents and Steps", () => {
  /** An Agent of the User whose cookie is given, with a token of that access. */
  async function agentOf(workspaceId: string, cookie: string, name: string, access: "read" | "write" | "full" = "write") {
    const agent = await (await cronk.request("POST", `/api/workspaces/${workspaceId}/agents`, { cookie, body: { name } })).json();
    const token = await (
      await cronk.request("POST", `/api/agents/${agent.id}/tokens`, { cookie, body: { name: "laptop", access } })
    ).json();
    return { authorization: `Bearer ${token.secret}` };
  }

  /** Every change to the board's Statuses and Steps; but for removing Ready, which Outcomes target, each would succeed in turn. */
  function boardChanges(project: Project, id: (name: string) => string) {
    return [
      ["POST", `/api/projects/${project.id}/statuses`, { name: "Mine", kind: "active" }],
      ["PATCH", `/api/projects/${project.id}/statuses/${id("Ready")}`, { name: "Ready to go", position: 0 }],
      ["PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, readyStep(id)],
      ["DELETE", `/api/projects/${project.id}/statuses/${id("Ready")}/step`],
      ["DELETE", `/api/projects/${project.id}/statuses/${id("Ready")}`],
    ] as const;
  }

  test("an Agent of an Admin with Write changes Statuses and Steps as a User does", async () => {
    const { workspace, cookie, project, id } = await projectOnDefaultBoard();
    const headers = await agentOf(workspace.id, cookie, "claude-max");

    let after = project;
    for (const [method, path, body] of boardChanges(project, id).slice(0, -1)) {
      const response = await cronk.request(method, path, { headers, body });
      expect(response.status, `${method} ${path}`).toBeLessThan(300);
      after = (await response.json()) as Project;
    }
    const mine = after.statuses.find((s) => s.name === "Mine")!;
    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${mine.id}`, { headers });
    expect(removed.status).toBe(200);
    after = (await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()) as Project;
    expect(after.statuses.find((s) => s.id === id("Ready"))!.step).toBeNull();
    expect(after.statuses.map((s) => s.name)).toEqual([
      "Ready to go",
      "Backlog",
      "Triage",
      "Investigate",
      "Implement",
      "Code review",
      "Merge",
      "In Review",
      "Done",
      "Canceled",
    ]);
  });

  test("an Agent meets the same rules as a User", async () => {
    const { workspace, cookie, project, id } = await projectOnDefaultBoard();
    const headers = await agentOf(workspace.id, cookie, "claude-max");
    await cronk.request("POST", `/api/projects/${project.id}/tickets`, { cookie, body: { title: "Waits in Backlog" } });

    for (const [method, path, body, code] of [
      ["DELETE", `/api/projects/${project.id}/statuses/${id("Backlog")}`, undefined, "status_has_tickets"],
      ["DELETE", `/api/projects/${project.id}/statuses/${id("Done")}`, undefined, "status_kind_needed"],
      ["PUT", `/api/projects/${project.id}/statuses/${id("Done")}/step`, readyStep(id), "step_on_done_or_canceled_status"],
      ["PATCH", `/api/projects/${project.id}/statuses/${id("Triage")}`, { kind: "done" }, "step_on_done_or_canceled_status"],
    ] as const) {
      const response = await cronk.request(method, path, { headers, body });
      expect(response.status, `${method} ${path}`).toBe(409);
      expect((await response.json()).error.code, `${method} ${path}`).toBe(code);
    }
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { headers })).json()).toEqual(project);
  });

  test("an Agent whose Owner isn't an Admin changes Statuses and removes Steps, but doesn't give or change one", async () => {
    const { workspace, cookie, project, id } = await projectOnDefaultBoard();
    const grace = await addMember(cronk, cookie, workspace.id, "grace@example.com");
    const headers = await agentOf(workspace.id, grace.cookie, "grace-claude");

    for (const status of ["Ready", "Triage"]) {
      const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id(status)}/step`, {
        headers,
        body: readyStep(id),
      });
      expect(response.status, status).toBe(403);
      expect((await response.json()).error).toEqual({
        code: "agent_not_allowed",
        message: expect.stringContaining("isn't an Admin"),
        rule: expect.stringContaining("only when its Owner is an Admin of the Workspace"),
        advice: expect.stringContaining("grace@example.com"),
      });
    }
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { headers })).json()).toEqual(project);

    const added = await cronk.request("POST", `/api/projects/${project.id}/statuses`, { headers, body: { name: "Mine", kind: "active" } });
    expect(added.status).toBe(201);
    const removed = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id("Triage")}/step`, { headers });
    expect(removed.status).toBe(200);
    // Grace herself, a User with Write, may.
    const put = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, {
      cookie: grace.cookie,
      body: readyStep(id),
    });
    expect(put.status).toBe(200);
  });

  test("without Write in the Project, Users and Agents are refused, and nothing changes", async () => {
    const { workspace, cookie, project, id } = await projectOnDefaultBoard();
    const grace = await addMember(cronk, cookie, workspace.id, "grace@example.com");
    const adasAgent = await agentOf(workspace.id, cookie, "claude-max");
    const gracesAgent = await agentOf(workspace.id, grace.cookie, "grace-claude");
    const reader = await agentOf(workspace.id, cookie, "reader", "read");
    await cronk.stage(
      "insert into project_members (project_id, workspace_id, user_id, level, created_at) values ($1, $2, $3, 'read', now())",
      [project.id, workspace.id, grace.user.id],
    );

    const refusals = async (as: { cookie?: string; headers?: Record<string, string> }, code: string) => {
      for (const [method, path, body] of boardChanges(project, id)) {
        const response = await cronk.request(method, path, { ...as, body });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect((await response.json()).error.code, `${method} ${path}`).toBe(code);
      }
    };
    // Grace has Read, and her Agent no more than its Owner.
    await refusals({ cookie: grace.cookie }, "read_access");
    await refusals({ headers: gracesAgent }, "read_access");
    await refusals({ headers: reader }, "read_only_token");
    await cronk.stage("update projects set agent_access = 'read' where id = $1", [project.id]);
    await refusals({ headers: adasAgent }, "read_access");

    const refused = await cronk.request("POST", `/api/projects/${project.id}/statuses`, { headers: adasAgent, body: { name: "Mine", kind: "active" } });
    expect((await refused.json()).error).toEqual({
      code: "read_access",
      message: "claude-max may only read CRONK.",
      rule: expect.stringContaining("needs Write in it"),
      advice: expect.stringContaining("ada@example.com"),
    });
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(project);
  });
});

describe("Outcome refusals", () => {
  let board: Awaited<ReturnType<typeof projectOnDefaultBoard>> | undefined;
  beforeEach(() => {
    board = undefined;
  });

  /** Tries to put a Step with these Outcomes on Ready, and checks nothing changed. */
  async function attempt(outcomes: (id: (name: string) => string) => Outcome[]) {
    board ??= await projectOnDefaultBoard();
    const { cookie, project, id } = board;
    const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, {
      cookie,
      body: { brief: "Plan the work.", model: "sonnet", outcomes: outcomes(id) },
    });
    const unchanged = await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json();
    expect(unchanged).toEqual(project);
    return { status: response.status, error: ((await response.json()) as { error: { code: string; message: string } }).error };
  }

  test("a Step without exactly one default Outcome is refused", async () => {
    expect(
      await attempt((id) => [outcome("planned", id("Investigate")), outcome("needs you", id("Backlog"), { needsYou: true })]),
    ).toEqual({
      status: 400,
      error: { code: "default_outcome_needed", message: "A Step needs exactly one default Outcome, and this one has none." },
    });
    expect(
      await attempt((id) => [
        outcome("planned", id("Investigate"), { default: true }),
        outcome("skip", id("Implement"), { default: true }),
        outcome("needs you", id("Backlog"), { needsYou: true }),
      ]),
    ).toEqual({
      status: 400,
      error: {
        code: "default_outcome_needed",
        message: "A Step needs exactly one default Outcome, and this one has 2: planned and skip.",
      },
    });
  });

  test("a Step without exactly one needs you Outcome is refused", async () => {
    expect(
      await attempt((id) => [outcome("planned", id("Investigate"), { default: true }), outcome("stuck", id("Backlog"))]),
    ).toEqual({
      status: 400,
      error: { code: "needs_you_outcome_needed", message: "A Step needs exactly one needs you Outcome, and this one has none." },
    });
    expect(
      await attempt((id) => [
        outcome("planned", id("Investigate"), { default: true }),
        outcome("stuck", id("Backlog"), { needsYou: true }),
        outcome("lost", id("Triage"), { needsYou: true }),
      ]),
    ).toEqual({
      status: 400,
      error: {
        code: "needs_you_outcome_needed",
        message: "A Step needs exactly one needs you Outcome, and this one has 2: stuck and lost.",
      },
    });
  });

  test("one Outcome can't be both the default and needs you", async () => {
    expect(
      await attempt((id) => [
        outcome("either", id("Backlog"), { default: true, needsYou: true }),
        outcome("planned", id("Investigate")),
      ]),
    ).toEqual({
      status: 400,
      error: {
        code: "outcome_default_and_needs_you",
        message: "either can't be both the default Outcome and the needs you Outcome: make them two Outcomes.",
      },
    });
  });

  test("a default or needs you Outcome targeting a Done or Canceled Status is refused", async () => {
    expect(
      await attempt((id) => [outcome("finished", id("Done"), { default: true }), outcome("needs you", id("Backlog"), { needsYou: true })]),
    ).toEqual({
      status: 409,
      error: {
        code: "outcome_target_not_allowed",
        message: "The default Outcome finished can't move Tickets to Done, a Done Status: skipping a Step must never complete work.",
      },
    });
    expect(
      await attempt((id) => [outcome("planned", id("Investigate"), { default: true }), outcome("needs you", id("Done"), { needsYou: true })]),
    ).toEqual({
      status: 409,
      error: {
        code: "outcome_target_not_allowed",
        message: "The needs you Outcome needs you can't move Tickets to Done, a Done Status: asking a User must never complete work.",
      },
    });
  });

  test("any Outcome targeting a Canceled Status is refused", async () => {
    expect(
      await attempt((id) => [
        outcome("planned", id("Investigate"), { default: true }),
        outcome("drop", id("Canceled")),
        outcome("needs you", id("Backlog"), { needsYou: true }),
      ]),
    ).toEqual({
      status: 409,
      error: {
        code: "outcome_target_not_allowed",
        message: "The Outcome drop can't move Tickets to Canceled, a Canceled Status: agents never cancel work.",
      },
    });
  });

  test("a needs you Outcome targeting the Status its Step is on is refused, naming the Outcome and the Status", async () => {
    expect(
      await attempt((id) => [outcome("planned", id("Investigate"), { default: true }), outcome("ask", id("Ready"), { needsYou: true })]),
    ).toEqual({
      status: 409,
      error: {
        code: "outcome_target_not_allowed",
        message:
          "The needs you Outcome ask can't move Tickets to Ready, the Status its Step is on: " +
          "asking a User must hand the Ticket back, not start the next Run at once.",
      },
    });
  });

  test("a default Outcome or one counting as a round may still target the Status its Step is on", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const step = {
      kind: "ordinary",
      brief: "Plan the work.",
      model: "sonnet",
      roundLimit: 2,
      labelRule: null,
      readOnly: false,
      outcomes: [
        outcome("again", id("Ready"), { default: true }),
        outcome("retry", id("Ready"), { countsAsRound: true }),
        outcome("needs you", id("Backlog"), { needsYou: true }),
      ],
    };

    const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, { cookie, body: step });

    expect(response.status).toBe(200);
    expect(((await response.json()) as Project).statuses.find((s) => s.name === "Ready")!.step).toEqual(step);
  });

  test("an Outcome targeting a Status outside the Project is refused", async () => {
    expect(
      await attempt(() => [
        outcome("planned", "00000000-0000-0000-0000-000000000000", { default: true }),
        outcome("needs you", "00000000-0000-0000-0000-000000000001", { needsYou: true }),
      ]),
    ).toEqual({
      status: 400,
      error: { code: "unknown_status", message: "The Outcome planned moves Tickets to a Status that isn't in this Project." },
    });
  });

  test("two Outcomes named alike, ignoring case, are refused", async () => {
    expect(
      await attempt((id) => [
        outcome("Planned", id("Investigate"), { default: true }),
        outcome("planned", id("Implement")),
        outcome("needs you", id("Backlog"), { needsYou: true }),
      ]),
    ).toEqual({
      status: 400,
      error: { code: "outcome_name_taken", message: "This Step already has an Outcome called planned." },
    });
  });
});

describe("no Step on finished or canceled work", () => {
  test("a Step on a Done or Canceled Status is refused, naming the Status, and nothing changes", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    for (const name of ["Done", "Canceled"]) {
      const response = await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id(name)}/step`, {
        cookie,
        body: {
          brief: "Wrap up.",
          model: "haiku",
          outcomes: [outcome("again", id("In Review"), { default: true }), outcome("needs you", id("Backlog"), { needsYou: true })],
        },
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error).toEqual({
        code: "step_on_done_or_canceled_status",
        message:
          `${name} is a ${name} Status, so it can't have a Step: ` +
          "a Ticket in a Done or Canceled Status is finished or canceled and gets no Runs.",
      });
    }
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(project);
  });

  test("making a Status with a Step Done or Canceled is refused, naming the Status and its Step, until the Step is removed", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const kindOf = (name: string, kind: string) =>
      cronk.request("PATCH", `/api/projects/${project.id}/statuses/${id(name)}`, { cookie, body: { kind } });

    for (const kind of ["Done", "Canceled"]) {
      const response = await kindOf("Investigate", kind.toLowerCase());
      expect(response.status).toBe(409);
      expect((await response.json()).error).toEqual({
        code: "step_on_done_or_canceled_status",
        message:
          `Investigate has a Step, so it can't be a ${kind} Status: ` +
          "a Ticket in a Done or Canceled Status is finished or canceled and gets no Runs. " +
          "Remove Investigate's Step first.",
      });
    }
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(project);

    await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id("Investigate")}/step`, { cookie });
    expect((await kindOf("Investigate", "done")).status).toBe(200);
  });
});

describe("Status changes keep Outcomes valid", () => {
  test("removing a Status an Outcome moves Tickets to is refused, naming the Outcome", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();

    const response = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id("Ready")}`, { cookie });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toEqual({
      code: "status_is_outcome_target",
      message:
        "Triage's Outcome ready moves Tickets to Ready. Change that Outcome or remove Triage's Step before removing Ready.",
    });
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(project);
  });

  test("once no Outcome moves Tickets to it, the Status can go", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    for (const name of ["Triage", "Implement"]) {
      const removed = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id(name)}/step`, { cookie });
      expect(removed.status).toBe(200);
    }

    const response = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id("Ready")}`, { cookie });

    expect(response.status).toBe(200);
  });

  test("a Status whose own Step is its only Outcome's way there can go with its Step", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const looping = {
      brief: "Look again.",
      model: "haiku",
      outcomes: [outcome("again", id("Investigate"), { default: true }), outcome("needs you", id("Backlog"), { needsYou: true })],
    };
    expect(
      (await cronk.request("PUT", `/api/projects/${project.id}/statuses/${id("Investigate")}/step`, { cookie, body: looping }))
        .status,
    ).toBe(200);

    const response = await cronk.request("DELETE", `/api/projects/${project.id}/statuses/${id("Investigate")}`, { cookie });

    expect(response.status).toBe(200);
  });

  test("making a Status Done or Canceled is refused while an Outcome may not move Tickets to such a Status", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const kindOf = (name: string, kind: string) =>
      cronk.request("PATCH", `/api/projects/${project.id}/statuses/${id(name)}`, { cookie, body: { kind } });

    const done = await kindOf("Ready", "done");
    expect(done.status).toBe(409);
    expect((await done.json()).error).toEqual({
      code: "outcome_target_not_allowed",
      message:
        "Triage's default Outcome ready moves Tickets to Ready, so Ready can't be a Done Status: skipping a Step must never complete work.",
    });

    const canceled = await kindOf("Implement", "canceled");
    expect(canceled.status).toBe(409);
    expect((await canceled.json()).error).toEqual({
      code: "outcome_target_not_allowed",
      message:
        "Investigate's default Outcome done moves Tickets to Implement, so Implement can't be a Canceled Status: " +
        "skipping a Step must never complete work.",
    });

    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { cookie })).json()).toEqual(project);
  });
});

describe("the Brief preview", () => {
  async function ticketIn(statusName: string) {
    const board = await projectOnDefaultBoard();
    const created = await cronk.request("POST", `/api/projects/${board.project.id}/tickets`, {
      cookie: board.cookie,
      body: { title: "Make it so" },
    });
    expect(created.status).toBe(201);
    const ticket = (await created.json()) as { id: string; key: string };
    const moved = await cronk.request("PATCH", `/api/tickets/${ticket.id}`, {
      cookie: board.cookie,
      body: { statusId: board.id(statusName) },
    });
    expect(moved.status).toBe(200);
    return { ...board, ticket };
  }

  test("a Ticket in a Status with a Step previews Cronk's preamble, the Step's Brief and the Ticket key", async () => {
    const { cookie, ticket, status } = await ticketIn("Triage");

    const response = await cronk.request("GET", `/api/tickets/${ticket.id}/brief`, { cookie });

    expect(response.status).toBe(200);
    const brief = await response.json();
    expect(brief.preamble).toBe(
      [
        "You are an agent working on the Ticket CRONK-1 in Cronk, as one Run of its Triage Step.",
        "",
        `Reach Cronk through its MCP server at ${cronk.url}/mcp. Read the Ticket there, with its Comments, Relations and the Reports of earlier Runs: this Brief doesn't repeat them.`,
        "",
        "CRONK-1 is in the Project CRONK (Cronker). Its Documents, glossary and Decisions, and the Workspace's, are " +
          'where the work\'s context is: pass `project: "CRONK"` to the tools that take one for the Project\'s own. ' +
          "Read another Project's only where the Ticket names it.",
        "",
        "Your Run id is given when the Run starts.",
        "",
        "End the Run by calling `finish` with your Run id and one of these Outcomes:",
        "",
        "- **ready**: moves CRONK-1 to Ready.",
        "- **needs you**: moves CRONK-1 to Backlog and hands it back to its Assignee. Give a Question saying what you need.",
        "",
        "Rules:",
        "",
        "- Call `finish` exactly once, as the last thing you do.",
        "- Work on until you call `finish`. Don't end your turn to wait for anything, such as CI or activity on a pull " +
          "request: Cronk can't tell a session waiting from one that has gone, so a Run whose session stops without " +
          "`finish` becomes lost.",
        "- *needs you* takes a Question.",
        "- While this Run is running you may edit CRONK-1's description, Priority, Labels, Release, due date and estimate, " +
          "write Reports on it and split it into Sub-Tickets with `create_sub_ticket`; leave everything else to its Users.",
        "- Before filing anything you find that isn't part of CRONK-1's work, `search` for an open Ticket that " +
          "already covers it and, for a fault in the code, check it still happens on the Repository's default branch. " +
          "If an open Ticket covers it, add what you found there as a Comment instead. Otherwise file it with " +
          "`file_ticket`, giving your Run id and naming any related Tickets in its description: it waits for " +
          "CRONK-1's Assignee as a Discovered Ticket.",
        "- Give your Run id when you create an Artifact with `create_artifact`, so it is linked to CRONK-1.",
        "- Don't merge pull requests on GitHub directly.",
        // Triage is read-only on the default board.
        "- This Step is read-only: don't change files in the Repository, and don't describe a change as made. Say in " +
          "your Report what should change instead.",
      ].join("\n"),
    );
    expect(brief.brief).toBe(status("Triage").step!.brief);
    expect(brief.ticketKey).toBe("CRONK-1");
    expect(brief.text).toBe(`${brief.preamble}\n\n${status("Triage").step!.brief}\n\nCRONK-1`);
  });

  test("the preview offers the Outcomes counting as a round, and those completing work only under Autonomous Delegation", async () => {
    const { cookie, ticket } = await ticketIn("Code review");

    const { preamble } = await (await cronk.request("GET", `/api/tickets/${ticket.id}/brief`, { cookie })).json();

    expect(preamble).toContain("- **approve**: moves CRONK-1 to Merge.\n");
    expect(preamble).toContain("- **changes**: moves CRONK-1 to Implement. It counts as a round: after 2, the Step's *needs you* Outcome applies instead.\n");
    expect(preamble).toContain("- **needs you**: moves CRONK-1 to In Review and hands it back to its Assignee.");
    expect(preamble).not.toContain("**complete**");
  });

  test("a Ticket in a Status without a Step has no Brief", async () => {
    const { cookie, ticket } = await ticketIn("Ready");

    const response = await cronk.request("GET", `/api/tickets/${ticket.id}/brief`, { cookie });

    expect(response.status).toBe(409);
    expect((await response.json()).error).toEqual({
      code: "status_has_no_step",
      message: "CRONK-1 is in Ready, which has no Step: Tickets there wait for a User, and get no Run.",
    });
  });

  test("an Agent reads the preview too; a Ticket out of view has none", async () => {
    const { workspace, cookie, ticket } = await ticketIn("Implement");
    const agent = await (
      await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie, body: { name: "claude-max" } })
    ).json();
    const token = await (
      await cronk.request("POST", `/api/agents/${agent.id}/tokens`, { cookie, body: { name: "laptop", access: "read" } })
    ).json();

    const asAgent = await cronk.request("GET", `/api/tickets/${ticket.id}/brief`, {
      headers: { authorization: `Bearer ${token.secret}` },
    });
    expect(asAgent.status).toBe(200);
    expect((await asAgent.json()).ticketKey).toBe("CRONK-1");

    const missing = await cronk.request("GET", "/api/tickets/00000000-0000-0000-0000-000000000000/brief", { cookie });
    expect(missing.status).toBe(404);
  });
});
