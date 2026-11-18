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

interface Status {
  id: string;
  name: string;
  kind: string;
  step: { brief: string; model: string; roundLimit: number; outcomes: Outcome[] } | null;
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
  test("a new Project has Steps on Triage, Investigate, Implement and Code review, with their Outcomes", async () => {
    const { project, id } = await projectOnDefaultBoard();

    const steps = Object.fromEntries(
      project.statuses.map((s) => [s.name, s.step && { model: s.step.model, roundLimit: s.step.roundLimit, outcomes: s.step.outcomes }]),
    );
    expect(steps).toEqual({
      Backlog: null,
      Triage: {
        model: "haiku",
        roundLimit: 2,
        outcomes: [outcome("ready", id("Ready"), { default: true }), outcome("needs you", id("Backlog"), { needsYou: true })],
      },
      Ready: null,
      Investigate: {
        model: "sonnet",
        roundLimit: 2,
        outcomes: [outcome("done", id("Implement"), { default: true }), outcome("needs you", id("Backlog"), { needsYou: true })],
      },
      Implement: {
        model: "opus",
        roundLimit: 2,
        outcomes: [outcome("done", id("Code review"), { default: true }), outcome("needs you", id("Ready"), { needsYou: true })],
      },
      "Code review": {
        model: "sonnet",
        roundLimit: 2,
        outcomes: [
          outcome("approve", id("In Review"), { default: true }),
          outcome("changes", id("Implement"), { countsAsRound: true }),
          outcome("complete", id("Done")),
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
  });
});

/** A Step for the Ready Status, sending Tickets on to Investigate or back to Backlog. */
function readyStep(id: (name: string) => string) {
  return {
    brief: "Plan the work.",
    model: "sonnet",
    roundLimit: 3,
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

  test("editing a Step replaces its Brief, model, round limit and Outcomes", async () => {
    const { cookie, project, id } = await projectOnDefaultBoard();
    const edited = {
      brief: "Triage, briefly.",
      model: "opus",
      roundLimit: 1,
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
  test("an Agent is refused any change to Statuses or Steps, and nothing changes", async () => {
    const { workspace, cookie, project, id } = await projectOnDefaultBoard();
    const agent = await (
      await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie, body: { name: "claude-max" } })
    ).json();
    const token = await (
      await cronk.request("POST", `/api/agents/${agent.id}/tokens`, { cookie, body: { name: "laptop", access: "full" } })
    ).json();
    const headers = { authorization: `Bearer ${token.secret}` };

    for (const [method, path, body] of [
      ["POST", `/api/projects/${project.id}/statuses`, { name: "Mine", kind: "active" }],
      ["PATCH", `/api/projects/${project.id}/statuses/${id("Ready")}`, { name: "Mine" }],
      ["DELETE", `/api/projects/${project.id}/statuses/${id("Ready")}`],
      ["PUT", `/api/projects/${project.id}/statuses/${id("Ready")}/step`, readyStep(id)],
      ["PUT", `/api/projects/${project.id}/statuses/${id("Triage")}/step`, readyStep(id)],
      ["DELETE", `/api/projects/${project.id}/statuses/${id("Triage")}/step`],
    ] as const) {
      const response = await cronk.request(method, path, { headers, body });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect((await response.json()).error, `${method} ${path}`).toEqual({
        code: "agent_not_allowed",
        message: expect.any(String),
        rule:
          "Agents may read their Workspace and comment on its Tickets; during their running Run on a Ticket they may also edit it, write Reports on it and finish the Run. Everything else needs a User.",
        advice: expect.stringContaining("ada@example.com"),
      });
    }
    expect(await (await cronk.request("GET", `/api/projects/${project.id}`, { headers })).json()).toEqual(project);
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
    expect((await kindOf("Investigate", "done")).status).toBe(200);
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
        "- *needs you* takes a Question.",
        "- Don't merge pull requests on GitHub directly.",
      ].join("\n"),
    );
    expect(brief.brief).toBe(status("Triage").step!.brief);
    expect(brief.ticketKey).toBe("CRONK-1");
    expect(brief.text).toBe(`${brief.preamble}\n\n${status("Triage").step!.brief}\n\nCRONK-1`);
  });

  test("the preview offers the Outcomes counting as a round, and those completing work only under Autonomous Delegation", async () => {
    const { cookie, ticket } = await ticketIn("Code review");

    const { preamble } = await (await cronk.request("GET", `/api/tickets/${ticket.id}/brief`, { cookie })).json();

    expect(preamble).toContain("- **approve**: moves CRONK-1 to In Review.\n");
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
