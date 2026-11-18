import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

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
  return { workspace, user, ada, project, ticket, runner, agent, asAgent: { headers: { authorization: `Bearer ${secret}` } }, status };
}

const runsOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}/runs`, as);

describe("starting Runs", () => {
  test("a delegated Ticket entering a Status with a Step starts one Run with the full Brief", async () => {
    const { ada, ticket, runner, agent, project, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

    const runs = await runsOf(ticket.id, ada);
    expect(runs).toEqual([
      {
        id: expect.any(String),
        ticketId: ticket.id,
        step: { statusId: status("Triage"), name: "Triage" },
        agent: { id: agent.id, name: "claude-max" },
        model: "haiku",
        state: "running",
        outcome: null,
        question: null,
        report: null,
        endReason: null,
        sessionUrl: "https://claude.ai/code/session_1",
        startedAt: "2026-01-01T09:00:00.000Z",
        endedAt: null,
      },
    ]);
    const [run] = runs;
    expect(cronk.runner.starts).toHaveLength(1);
    const [start] = cronk.runner.starts;
    expect(start).toEqual({
      runId: run.id,
      brief: expect.any(String),
      model: "haiku",
      ticket: { id: ticket.id, key: "CRONK-1" },
      project: { id: project.id, key: "CRONK", name: "Cronker" },
      agent: { id: agent.id, name: "claude-max" },
      runner: { id: runner.id, ownerId: agent.owner.id, name: "Fake" },
    });

    // The Brief: Cronk's preamble naming the Run, then the Step's Brief, then the Ticket key.
    const brief = await ok("GET", `/api/runs/${run.id}/brief`, ada);
    expect(brief.preamble).toBe(
      [
        "You are an agent working on the Ticket CRONK-1 in Cronk, as one Run of its Triage Step.",
        "",
        `Reach Cronk through its MCP server at ${cronk.url}/mcp. Read the Ticket there, with its Comments, ` +
          "Relations and the Reports of earlier Runs: this Brief doesn't repeat them.",
        "",
        `Your Run id is ${run.id}.`,
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
    expect(brief.brief).toMatch(/^Triage this Ticket so the next Steps can work on it without asking\./);
    expect(brief.ticketKey).toBe("CRONK-1");
    expect(brief.text.startsWith(`${brief.preamble}\n\nTriage this Ticket`)).toBe(true);
    expect(brief.text.endsWith("\n\nCRONK-1")).toBe(true);
    expect(start!.brief).toBe(brief.text);
  });

  test("undelegated Tickets never get Runs, and Statuses without a Step start none", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    expect(await runsOf(ticket.id, ada)).toEqual([]);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready"), delegateId: agent.id });
    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect(cronk.runner.starts).toEqual([]);
  });

  test("no Run starts for a Ticket in a Done or Canceled Status, which can never have a Step", async () => {
    const { ada, ticket, agent, project, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    const step = {
      brief: "Wrap up.",
      model: "haiku",
      outcomes: [
        { name: "again", statusId: status("In Review"), default: true, needsYou: false, countsAsRound: false },
        { name: "needs you", statusId: status("Backlog"), default: false, needsYou: true, countsAsRound: false },
      ],
    };
    for (const name of ["Done", "Canceled"]) {
      expect((await call("PUT", `/api/projects/${project.id}/statuses/${status(name)}/step`, ada, step)).status).toBe(409);
      await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status(name) });
    }
    expect((await call("PATCH", `/api/projects/${project.id}/statuses/${status("Investigate")}`, ada, { kind: "done" })).status).toBe(409);

    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect(cronk.runner.starts).toEqual([]);
  });

  test("delegating a Ticket already in a Status with a Step starts a Run there", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Investigate") });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { step: { name: string }; model: string; state: string }) => [r.step.name, r.model, r.state])).toEqual([
      ["Investigate", "sonnet", "running"],
    ]);
  });
});

describe("finishing Runs", () => {
  /** Finishes the Ticket's running Run as its Agent, and returns the finished Run. */
  async function finish(ticketId: string, asAgent: Request, ada: Request, body: unknown) {
    const running = (await runsOf(ticketId, ada)).find((r: { state: string }) => r.state === "running");
    return ok("POST", `/api/runs/${running.id}/finish`, asAgent, body);
  }

  test("Runs walk a Ticket through Triage to Ready, and from Investigate on to Implement", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const triaged = await finish(ticket.id, asAgent, ada, { outcome: "ready", report: "Clear enough." });
    expect(triaged).toEqual(
      expect.objectContaining({ state: "finished", outcome: "ready", report: "Clear enough.", endedAt: expect.any(String) }),
    );
    // Ready has no Step: the Ticket waits there for a User.
    let current = await ok("GET", `/api/tickets/${ticket.id}`, ada);
    expect(current.statusId).toBe(status("Ready"));
    expect(cronk.runner.starts).toHaveLength(1);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Investigate") });
    await finish(ticket.id, asAgent, ada, { outcome: "DONE" });

    current = await ok("GET", `/api/tickets/${ticket.id}`, ada);
    expect(current.statusId).toBe(status("Implement"));
    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { step: { name: string }; model: string; state: string; outcome: string | null }) => [
      r.step.name,
      r.model,
      r.state,
      r.outcome,
    ])).toEqual([
      ["Triage", "haiku", "finished", "ready"],
      ["Investigate", "sonnet", "finished", "done"],
      ["Implement", "opus", "running", null],
    ]);
    expect(cronk.runner.starts.map((s) => s.model)).toEqual(["haiku", "sonnet", "opus"]);

    // The timeline names the Agent for the moves its Runs made.
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    const moves = timeline.filter((c: { field: string }) => c.field === "status");
    expect(moves.map((c: { actor: { name: string }; to: { name: string } }) => [c.actor.name, c.to.name])).toEqual([
      ["ada@example.com", "Triage"],
      ["claude-max", "Ready"],
      ["ada@example.com", "Investigate"],
      ["claude-max", "Implement"],
    ]);
  });
});

describe("what finish refuses", () => {
  async function runningRun() {
    const setup = await adaWithAgent();
    const { ada, ticket, agent, status } = setup;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    return { ...setup, run };
  }

  test("an Outcome the Run isn't offered, naming those it is", async () => {
    const { ada, ticket, run, asAgent, status } = await runningRun();

    const response = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "approve" });

    expect(response.status).toBe(400);
    expect(response.json.error).toEqual({
      code: "outcome_not_offered",
      message: "approve isn't an Outcome this Run may choose.",
      rule: expect.any(String),
      advice: "Finish with one of these Outcomes: ready, needs you.",
    });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Triage"));
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });

  test("an Outcome completing work, which needs Autonomous Delegation", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Code review") });
    const [run] = await runsOf(ticket.id, ada);

    const response = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "complete" });

    expect(response.status).toBe(400);
    expect(response.json.error.advice).toBe("Finish with one of these Outcomes: approve, changes, needs you.");
  });

  test("a Run that isn't running any more", async () => {
    const { run, asAgent } = await runningRun();
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    const again = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    expect(again.status).toBe(409);
    expect(again.json.error).toEqual(expect.objectContaining({ code: "run_not_running", advice: expect.any(String) }));
  });

  test("another Agent's Run, and Users, who don't finish Runs", async () => {
    const { workspace, ada, run, ticket, status } = await runningRun();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "other-bot" });
    const { secret } = await ok("POST", `/api/agents/${other.id}/tokens`, ada, { name: "cloud", access: "full" });

    const byOther = await call("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` } }, {
      outcome: "ready",
    });
    expect(byOther.status).toBe(403);
    expect(byOther.json.error).toEqual(expect.objectContaining({ code: "not_your_run", rule: expect.any(String) }));

    const byUser = await call("POST", `/api/runs/${run.id}/finish`, ada, { outcome: "ready" });
    expect(byUser.status).toBe(403);
    expect(byUser.json.error.code).toBe("not_runs_agent");
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Triage"));
  });

  test("a Run of another Workspace answers as not found", async () => {
    const { ada, run } = await runningRun();
    const elsewhere = await ok("POST", "/api/workspaces", ada, { name: "Elsewhere" });
    const agent = await ok("POST", `/api/workspaces/${elsewhere.id}/agents`, ada, { name: "far-bot" });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
    const far = { headers: { authorization: `Bearer ${secret}` } };

    expect((await call("POST", `/api/runs/${run.id}/finish`, far, { outcome: "ready" })).status).toBe(404);
    expect((await call("GET", `/api/runs/${run.id}/brief`, far)).status).toBe(404);
  });
});

describe("a Run whose Ticket a User moved meanwhile", () => {
  test("finishing it is refused, leaving the Ticket where the User put it", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });

    const response = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "needs you", question: "?" });

    expect(response.status).toBe(409);
    expect(response.json.error).toEqual(expect.objectContaining({ code: "ticket_moved", advice: expect.any(String) }));
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Ready"));
  });

  test("moving it into another Step's Status records no Run beside the running one, even a refused one", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: null });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Investigate") });

    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { step: { name: string }; state: string }) => [r.step.name, r.state])).toEqual([["Triage", "running"]]);
  });
});

describe("Agents and Statuses", () => {
  test("an Agent can't set a Status directly, and is pointed to finish", async () => {
    const { ada, ticket, asAgent, status } = await adaWithAgent();

    const response = await call("PATCH", `/api/tickets/${ticket.id}`, asAgent, { statusId: status("Triage") });

    expect(response.status).toBe(403);
    expect(response.json.error).toEqual({
      code: "agent_sets_no_status",
      message: expect.any(String),
      rule: "An Agent never sets a Status: a Run moves its Ticket only by finishing with one of its Outcomes.",
      advice: expect.stringContaining("`finish`"),
    });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Backlog"));
  });
});

describe("at most one running Run per Ticket", () => {
  test("even under concurrent requests", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

    // Delegating and moving between two Statuses with Steps, all at once.
    const responses = await Promise.all([
      call("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id }),
      call("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") }),
      call("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Implement") }),
      call("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") }),
    ]);

    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    const runs = await runsOf(ticket.id, ada);
    expect(runs.filter((r: { state: string }) => r.state === "running")).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(cronk.runner.starts).toHaveLength(1);
  });
});

describe("when Runners don't run", () => {
  test("a Runner refusing to start a Run leaves it refused, with the reason, and the Ticket where it is", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    cronk.runner.refuseNext({ kind: "credentials_rejected", message: "The trigger's token was rejected." });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const [run] = await runsOf(ticket.id, ada);
    expect(run).toEqual(
      expect.objectContaining({ state: "refused", endReason: "The trigger's token was rejected.", endedAt: expect.any(String) }),
    );
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Triage"));
  });

  test("a Delegate using no Runner gets a refused Run saying so", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: null });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const [run] = await runsOf(ticket.id, ada);
    expect(run).toEqual(expect.objectContaining({ state: "refused", endReason: expect.stringContaining("claude-max uses no Runner") }));
    expect(cronk.runner.starts).toEqual([]);
  });

  test("a Run its Runner reports ended without finishing is failed, and can't be finished", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);

    await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");

    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(
      expect.objectContaining({ state: "failed", endReason: "The session crashed." }),
    );
    expect((await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" })).status).toBe(409);
  });
});

describe("Runners and Agents", () => {
  test("an Agent uses only one of its Owner's own Runners, of a kind this Cronk has", async () => {
    const { ada, agent } = await adaWithAgent();

    const unknown = await call("POST", "/api/runners", ada, { name: "Mystery", kind: "mystery" });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toEqual({ code: "unknown_runner_kind", message: "This Cronk has no Runner of the kind mystery; it has fake." });

    expect(await ok("GET", "/api/runners", ada)).toEqual([
      { id: agent.runnerId, name: "Fake", kind: "fake", createdAt: expect.any(String) },
    ]);
    const notOwn = await call("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: "00000000-0000-0000-0000-000000000000" });
    expect(notOwn.json.error.code).toBe("unknown_runner");
  });
});

describe("Runs on the board", () => {
  test("each Ticket on the board carries its latest Run's state", async () => {
    const { ada, project, ticket, agent, asAgent, status } = await adaWithAgent();
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Not delegated" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);

    const lastRuns = async () =>
      Object.fromEntries(
        (await ok("GET", `/api/projects/${project.id}/tickets`, ada)).map((t: { key: string; lastRun: unknown }) => [t.key, t.lastRun]),
      );
    expect(await lastRuns()).toEqual({ "CRONK-1": { id: run.id, state: "running" }, "CRONK-2": null });

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    expect(await lastRuns()).toEqual({ "CRONK-1": { id: run.id, state: "finished" }, "CRONK-2": null });
    expect(other.lastRun).toBeNull();
  });
});

describe("Runs live", () => {
  test("a Run starting, failing and finishing each tells the Workspace's streams its Ticket changed", async () => {
    const { workspace, ada, project, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    const stream = await openStream(cronk, ada.cookie!, workspace.id);
    const changed = { type: "ticket.changed", data: { projectId: project.id, ticketId: ticket.id } };

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    // The move, then the Run's session once its Runner started it.
    expect(await stream.next()).toEqual(changed);
    expect(await stream.next()).toEqual(changed);

    const [run] = await runsOf(ticket.id, ada);
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    expect(await stream.next()).toEqual(changed);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Investigate") });
    expect(await stream.next()).toEqual(changed);
    expect(await stream.next()).toEqual(changed);
    const [, second] = await runsOf(ticket.id, ada);
    await cronk.runner.endWithoutFinishing(second.id);
    expect(await stream.next()).toEqual(changed);
    stream.close();
  });
});
