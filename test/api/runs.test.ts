import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
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
 * using her fake Runner, with a Write token.
 */
async function adaWithAgent() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
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
        machineModel: null,
        state: "running",
        outcome: null,
        question: null,
        questionBy: null,
        endReason: null,
        sessionUrl: "https://claude.ai/code/cse_1",
        cost: null,
        transcriptId: null,
        transcriptSlug: null,
        transcriptDeleted: false,
        startedAt: "2026-01-01T09:00:00.000Z",
        endedAt: null,
        lastCallAt: null,
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
      repositories: [],
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
      ].join("\n"),
    );
    expect(brief.brief).toMatch(/^Triage this Ticket so the next Steps can work on it without asking\./);
    expect(brief.ticketKey).toBe("CRONK-1");
    expect(brief.text.startsWith(`${brief.preamble}\n\nTriage this Ticket`)).toBe(true);
    expect(brief.text.endsWith("\n\nCRONK-1")).toBe(true);
    expect(start!.brief).toBe(brief.text);
  });

  test("with Concise Reports on, the preview and a started Run's Brief ask for concise Reports; off, they don't", async () => {
    const { ada, ticket, agent, project, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    const rule = /^- This Project keeps Reports concise, even where the Step's brief asks for more: lead with the outcome/m;
    expect((await ok("GET", `/api/tickets/${ticket.id}/brief`, ada)).preamble).not.toMatch(rule);

    expect(project.conciseReports).toBe(false);
    expect(await ok("PATCH", `/api/projects/${project.id}`, ada, { conciseReports: true })).toMatchObject({ conciseReports: true });
    expect(await ok("GET", `/api/projects/${project.id}`, ada)).toMatchObject({ conciseReports: true });

    const preview = await ok("GET", `/api/tickets/${ticket.id}/brief`, ada);
    expect(preview.preamble).toMatch(rule);
    expect(preview.preamble.endsWith("as a step-by-step log of what you read or tried.")).toBe(true);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    const [run] = await runsOf(ticket.id, ada);
    expect((await ok("GET", `/api/runs/${run.id}/brief`, ada)).preamble).toMatch(rule);
    expect(cronk.runner.starts[0]!.brief).toMatch(rule);

    await ok("PATCH", `/api/projects/${project.id}`, ada, { conciseReports: false });
    expect((await ok("GET", `/api/tickets/${ticket.id}/brief`, ada)).preamble).not.toMatch(rule);
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
      expect.objectContaining({ state: "finished", outcome: "ready", endedAt: expect.any(String) }),
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
    const { secret } = await ok("POST", `/api/agents/${other.id}/tokens`, ada, { name: "cloud", access: "write" });

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
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
    const far = { headers: { authorization: `Bearer ${secret}` } };

    expect((await call("POST", `/api/runs/${run.id}/finish`, far, { outcome: "ready" })).status).toBe(404);
    expect((await call("GET", `/api/runs/${run.id}/brief`, far)).status).toBe(404);
  });
});

describe("a Run whose Ticket a User moved meanwhile", () => {
  test("finishing it is refused, since the move stopped it, leaving the Ticket where the User put it", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });

    const response = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "needs you", question: "?" });

    expect(response.status).toBe(409);
    expect(response.json.error).toEqual(expect.objectContaining({ code: "run_stopped", advice: expect.any(String) }));
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Ready"));
  });
});

describe("Agents and Statuses", () => {
  test("an Agent can't set a Status directly, and is pointed to finish", async () => {
    const { ada, ticket, asAgent, status } = await adaWithAgent();

    const response = await call("PATCH", `/api/tickets/${ticket.id}`, asAgent, { statusId: status("Triage") });

    expect(response.status).toBe(403);
    expect(response.json.error).toEqual({
      code: "full_token_needed",
      message: expect.any(String),
      rule: expect.stringContaining("a Run moves its Ticket only by finishing with one of its Outcomes"),
      advice: expect.stringContaining("Full token"),
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
    // Each move stops the running Run before starting the next, so only the latest is running.
    const runs = await runsOf(ticket.id, ada);
    expect(runs.filter((r: { state: string }) => r.state === "running")).toHaveLength(1);
    expect(runs.at(-1).state).toBe("running");
    expect(runs.slice(0, -1).every((r: { state: string }) => r.state === "stopped")).toBe(true);
    // Every Run recorded was asked of the Runner, and only those.
    expect(cronk.runner.starts.map((s) => s.runId).sort()).toEqual(runs.map((r: { id: string }) => r.id).sort());
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
    expect(unknown.json.error).toEqual({ code: "unknown_runner_kind", message: "This Cronk has no Runner of the kind mystery; it has subscription, managed_agents, local, fake." });

    expect(await ok("GET", "/api/runners", ada)).toEqual([
      {
        id: agent.runnerId,
        name: "Fake",
        kind: "fake",
        cloud: false,
        limit: 2,
        running: 0,
        pausedUntil: null,
        offlineSince: null,
        triggers: [],
        managedAgents: null,
        budgetPerRun: null,
        allowedTools: null,
        machineModels: null,
        costThisMonth: [],
        createdAt: expect.any(String),
      },
    ]);
    const notOwn = await call("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: "00000000-0000-0000-0000-000000000000" });
    expect(notOwn.json.error.code).toBe("unknown_runner");
  });

  test("a Runner says how many of its Runs are running, and the count falls when one finishes", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    expect(await ok("GET", "/api/runners", ada)).toEqual([expect.objectContaining({ limit: 2, running: 0 })]);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    expect(await ok("GET", "/api/runners", ada)).toEqual([expect.objectContaining({ limit: 2, running: 1 })]);

    const [run] = await runsOf(ticket.id, ada);
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    expect(await ok("GET", "/api/runners", ada)).toEqual([expect.objectContaining({ limit: 2, running: 0 })]);
  });
});

describe("removing a Runner", () => {
  test("its Owner removes a Runner, and it is gone from their Runners", async () => {
    const { ada, runner } = await adaWithAgent();

    expect((await call("DELETE", `/api/runners/${runner.id}`, ada)).status).toBe(204);

    expect(await ok("GET", "/api/runners", ada)).toEqual([]);
    expect((await call("DELETE", `/api/runners/${runner.id}`, ada)).status).toBe(404);
  });

  test("another User can't remove it, as if it didn't exist", async () => {
    const { workspace, ada, runner } = await adaWithAgent();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");

    const refused = await call("DELETE", `/api/runners/${runner.id}`, bea);

    expect(refused.status).toBe(404);
    expect(refused.json.error).toEqual({ code: "not_found", message: "You have no such Runner." });
    expect(await ok("GET", "/api/runners", ada)).toEqual([expect.objectContaining({ id: runner.id })]);
  });

  test("removing it is refused while one of its Runs is running", async () => {
    const { ada, ticket, agent, asAgent, runner, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const refused = await call("DELETE", `/api/runners/${runner.id}`, ada);

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual({
      code: "runner_running",
      message: "Fake has a Run running. Wait for its running Runs to end, or stop them first.",
    });
    expect(await ok("GET", "/api/runners", ada)).toEqual([expect.objectContaining({ id: runner.id, running: 1 })]);

    const [run] = await runsOf(ticket.id, ada);
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    expect((await call("DELETE", `/api/runners/${runner.id}`, ada)).status).toBe(204);
  });

  test("Agents pointed at it are left with no Runner, so their delegated Tickets get Runs refused as for any such Agent", async () => {
    const { workspace, ada, ticket, agent, runner, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    await ok("DELETE", `/api/runners/${runner.id}`, ada);

    const agents = await ok("GET", `/api/workspaces/${workspace.id}/agents`, ada);
    expect(agents).toEqual([expect.objectContaining({ id: agent.id, runnerId: null })]);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
    expect(await runsOf(ticket.id, ada)).toEqual([
      expect.objectContaining({
        state: "refused",
        endReason: "claude-max uses no Runner: its Owner points it at one of their Runners for it to start Runs.",
      }),
    ]);
    expect(cronk.runner.starts).toEqual([]);
  });

  test("Tickets waiting in its paused queue stop waiting for it, as for an Agent with no Runner", async () => {
    const { ada, ticket, agent, runner, status, project } = await adaWithAgent();
    cronk.runner.refuseNext({ kind: "rate_limited", message: "Too many fires.", retryAt: new Date("2026-01-01T10:00:00Z") });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).waiting).toBe("runnerPaused");

    await ok("DELETE", `/api/runners/${runner.id}`, ada);

    const [card] = await ok("GET", `/api/projects/${project.id}/tickets`, ada);
    expect(card).toMatchObject({ waiting: null, lastRun: expect.objectContaining({ state: "refused" }) });
    expect(await runsOf(ticket.id, ada)).toEqual([
      expect.objectContaining({
        state: "refused",
        endReason: "claude-max uses no Runner: its Owner points it at one of their Runners for it to start Runs.",
      }),
    ]);
  });

  test("its past Runs keep their history", async () => {
    const { ada, ticket, agent, asAgent, runner, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);
    const { avoidedWords: _, ...finished } = await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    await ok("DELETE", `/api/runners/${runner.id}`, ada);

    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(finished);
    expect(await runsOf(ticket.id, ada)).toEqual([finished]);
  });
});

describe("Label rules", () => {
  /** Puts a Label rule on the Step of the named Status, keeping the rest of the Step. */
  async function setLabelRule(
    setup: Awaited<ReturnType<typeof adaWithAgent>>,
    statusName: string,
    labelRule: { kind: "requires" | "skippedBy"; label: string },
  ) {
    const { ada, project, status } = setup;
    const { step } = project.statuses.find((s: { name: string }) => s.name === statusName);
    await ok("PUT", `/api/projects/${project.id}/statuses/${status(statusName)}/step`, ada, { ...step, labelRule });
  }

  test("a Ticket labelled no-review skips Code review: no Run, and it moves on by approve, which Cronk records, then past Merge", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, labels: ["No-Review"] });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Code review") });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("In Review"));
    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect(cronk.runner.starts).toEqual([]);
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.slice(-5)).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ kind: "user", name: "ada@example.com" }),
        field: "status",
        to: { id: status("Code review"), name: "Code review" },
      }),
      expect.objectContaining({
        actor: { kind: "cronk", name: "Cronk" },
        field: "stepSkipped",
        from: null,
        to: {
          status: { id: status("Code review"), name: "Code review" },
          labelRule: { kind: "skippedBy", label: "no-review" },
          outcome: "approve",
        },
      }),
      expect.objectContaining({
        actor: { kind: "cronk", name: "Cronk" },
        field: "status",
        from: { id: status("Code review"), name: "Code review" },
        to: { id: status("Merge"), name: "Merge" },
      }),
      // The default board's Merge Step skips itself too: agents may not merge in a new Project.
      expect.objectContaining({ actor: { kind: "cronk", name: "Cronk" }, field: "stepSkipped" }),
      expect.objectContaining({
        actor: { kind: "cronk", name: "Cronk" },
        field: "status",
        from: { id: status("Merge"), name: "Merge" },
        to: { id: status("In Review"), name: "In Review" },
      }),
    ]);
  });

  test("an Outcome moving a Ticket into a skipped Step passes it on too", async () => {
    const { ada, ticket, agent, asAgent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Implement") });
    const [run] = await runsOf(ticket.id, ada);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { labels: ["no-review"] });

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "done" });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("In Review"));
    expect((await runsOf(ticket.id, ada)).map((r: { step: { name: string } }) => r.step.name)).toEqual(["Implement"]);
  });

  test("a Ticket without a Step's required Label skips it, chaining into the next Step's Run", async () => {
    const setup = await adaWithAgent();
    const { ada, ticket, agent, status } = setup;
    await setLabelRule(setup, "Investigate", { kind: "requires", label: "unclear" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Investigate") });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Implement"));
    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { step: { name: string }; state: string }) => [r.step.name, r.state])).toEqual([["Implement", "running"]]);
    expect(cronk.runner.starts.map((s) => s.model)).toEqual(["opus"]);
  });

  test("a Ticket with a Step's required Label gets its Run", async () => {
    const setup = await adaWithAgent();
    const { ada, ticket, agent, status } = setup;
    await setLabelRule(setup, "Investigate", { kind: "requires", label: "unclear" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Investigate"), labels: ["UNCLEAR"] });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Investigate"));
    expect((await runsOf(ticket.id, ada)).map((r: { step: { name: string } }) => r.step.name)).toEqual(["Investigate"]);
  });

  test("delegating a Ticket that sits in a Step it doesn't pass moves it on", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Code review"), labels: ["no-review"] });
    // Undelegated, it waits there for a User like any other Ticket.
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Code review"));

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("In Review"));
    expect(await runsOf(ticket.id, ada)).toEqual([]);
  });

  test("skipped Steps that pass a Ticket round in a circle stop where it came back to, with no Run", async () => {
    const setup = await adaWithAgent();
    const { ada, ticket, agent, status } = setup;
    // Implement's default sends to Code review, and Code review's default is changed to send back to Implement.
    const { project } = setup;
    const review = project.statuses.find((s: { name: string }) => s.name === "Code review").step;
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Code review")}/step`, ada, {
      ...review,
      outcomes: review.outcomes.map((o: { name: string; default: boolean }) => ({ ...o, default: o.name === "changes" })),
    });
    await setLabelRule(setup, "Implement", { kind: "skippedBy", label: "no-review" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, labels: ["no-review"] });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Implement") });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Implement"));
    expect(await runsOf(ticket.id, ada)).toEqual([]);
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.filter((c: { field: string }) => c.field === "status").map((c: { to: { name: string } }) => c.to.name)).toEqual([
      "Implement",
      "Code review",
      "Implement",
    ]);
  });
});

describe("rounds", () => {
  /** Finishes the Ticket's running Run as its Agent with the Outcome, and returns the finished Run. */
  async function finishWith(setup: Awaited<ReturnType<typeof adaWithAgent>>, outcome: string, extra: object = {}) {
    const { ada, asAgent, ticket } = setup;
    const running = (await runsOf(ticket.id, ada)).find((r: { state: string }) => r.state === "running");
    return ok("POST", `/api/runs/${running.id}/finish`, asAgent, { outcome, ...extra });
  }

  test("past Code review's round limit of 2, changes applies needs you instead, with Cronk's Question", async () => {
    const setup = await adaWithAgent();
    const { ada, ticket, agent, status } = setup;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Code review") });

    for (let round = 1; round <= 2; round++) {
      const sentBack = await finishWith(setup, "changes");
      expect(sentBack).toEqual(expect.objectContaining({ outcome: "changes", question: null, questionBy: null }));
      expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Implement"));
      await finishWith(setup, "done");
    }
    const third = await finishWith(setup, "changes");

    expect(third).toEqual(
      expect.objectContaining({
        state: "finished",
        outcome: "needs you",
        question:
          "Code review sent CRONK-1 back by changes 2 times, its round limit, so it comes to you instead. " +
          "Read the latest Reports, then move it on yourself.",
        questionBy: "cronk",
      }),
    );
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("In Review"));
    expect((await runsOf(ticket.id, ada)).filter((r: { state: string }) => r.state === "running")).toEqual([]);
  });

  test("a Question an Agent asks with needs you is its own", async () => {
    const setup = await adaWithAgent();
    const { ada, ticket, agent, status } = setup;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const run = await finishWith(setup, "needs you", { question: "What is it for?" });

    expect(run).toEqual(expect.objectContaining({ outcome: "needs you", question: "What is it for?", questionBy: "agent" }));
  });

  test("a round limit of 0 sends the first round to needs you", async () => {
    const setup = await adaWithAgent();
    const { ada, project, ticket, agent, status } = setup;
    const { step } = project.statuses.find((s: { name: string }) => s.name === "Code review");
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Code review")}/step`, ada, { ...step, roundLimit: 0 });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Code review") });

    const run = await finishWith(setup, "changes");

    expect(run).toEqual(expect.objectContaining({ outcome: "needs you", questionBy: "cronk" }));
    expect(run.question).toMatch(/^Code review sent CRONK-1 back by changes 0 times, its round limit/);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("In Review"));
  });

  test("a User moving the Ticket by hand resets its round counts", async () => {
    const setup = await adaWithAgent();
    const { ada, ticket, agent, status } = setup;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Code review") });
    for (let round = 1; round <= 2; round++) {
      await finishWith(setup, "changes");
      await finishWith(setup, "done");
    }
    // Code review approves it into In Review, and Ada moves it back into Code review by hand.
    await finishWith(setup, "approve");
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Code review") });

    for (let round = 1; round <= 2; round++) {
      expect((await finishWith(setup, "changes")).outcome).toBe("changes");
      await finishWith(setup, "done");
    }
    expect((await finishWith(setup, "changes")).outcome).toBe("needs you");
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
    // With the Status it ran in and its session, for the card's menu; no Transcript was uploaded.
    const latest = { id: run.id, statusId: status("Triage"), sessionUrl: run.sessionUrl, transcriptSlug: null };
    expect(run.sessionUrl).toMatch(/^https:\/\/claude\.ai\/code\//);
    expect(await lastRuns()).toEqual({ "CRONK-1": { ...latest, state: "running" }, "CRONK-2": null });

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    expect(await lastRuns()).toEqual({ "CRONK-1": { ...latest, state: "finished" }, "CRONK-2": null });
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

describe("answering with the Ticket as its edit or creation left it", () => {
  test("delegating a Ticket into a Status with a Step answers with the Run it started, as a GET shows it", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

    const delegated = await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });

    const [run] = await runsOf(ticket.id, ada);
    expect(delegated.lastRun).toEqual({ id: run.id, state: "running", statusId: status("Triage"), sessionUrl: null, transcriptSlug: null });
    // Its session is known once the Runner has started it, after the answer.
    const shown = await ok("GET", `/api/tickets/${ticket.id}`, ada);
    expect(delegated).toEqual({ ...shown, lastRun: { ...shown.lastRun, sessionUrl: null } });
  });

  test("moving a delegated Ticket with an unfinished Sub-Ticket into a Status with a Step answers that it waits, blocked", async () => {
    const { ada, project, ticket, agent, status } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
    await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "First half", parentId: ticket.id });

    const moved = await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

    expect(moved.waiting).toBe("blocked");
    expect(moved.lastRun).toBeNull();
    expect(moved).toEqual(await ok("GET", `/api/tickets/${ticket.id}`, ada));
  });

  test("creating a Ticket that starts delegated in a Status with a Step answers with the Run it started", async () => {
    const { ada, project, status } = await adaWithAgent();
    await ok("PATCH", `/api/projects/${project.id}`, ada, { newTicketsDelegated: true });
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Backlog")}/step`, ada, {
      brief: "Look before you leap.",
      model: "haiku",
      outcomes: [
        { name: "ready", statusId: status("Ready"), default: true, needsYou: false, countsAsRound: false },
        { name: "needs you", statusId: status("Triage"), default: false, needsYou: true, countsAsRound: false },
      ],
    });

    const created = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Born delegated" });

    const [run] = await runsOf(created.id, ada);
    expect(created.lastRun).toEqual({ id: run.id, state: "running", statusId: status("Backlog"), sessionUrl: null, transcriptSlug: null });
    // Its session is known once the Runner has started it, after the answer.
    const shown = await ok("GET", `/api/tickets/${created.id}`, ada);
    expect(created).toEqual({ ...shown, lastRun: { ...shown.lastRun, sessionUrl: null } });
  });
});
