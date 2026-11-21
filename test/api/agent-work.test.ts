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
 * Ada with a Project on the default board, a Ticket CRONK-1 her Agent `claude-max` is running a Triage Run on,
 * through her fake Runner, and a second Ticket CRONK-2 in Backlog.
 */
async function runningRun() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Something else" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, ada, project, ticket, other, agent, run, asAgent, status };
}

describe("an Agent editing its Ticket during its Run", () => {
  test("edits the description, Priority, Labels, due date and estimate, each Change naming the Agent and its Run", async () => {
    const { ada, ticket, agent, run, asAgent } = await runningRun();

    const edited = await ok("PATCH", `/api/tickets/${ticket.id}`, asAgent, {
      description: "Steps to reproduce: run it.",
      priority: "high",
      labels: ["bug", "parser"],
      dueDate: "2026-02-01",
      estimate: 3,
    });

    expect(edited).toEqual(
      expect.objectContaining({
        description: "Steps to reproduce: run it.",
        priority: "high",
        labels: ["bug", "parser"],
        dueDate: "2026-02-01",
        estimate: 3,
      }),
    );
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    const byAgent = timeline.filter((c: { actor: { kind: string } }) => c.actor.kind === "agent");
    expect(byAgent.map((c: { field: string; to: unknown; runId: string }) => [c.field, c.to, c.runId])).toEqual([
      ["description", "Steps to reproduce: run it.", run.id],
      ["priority", "high", run.id],
      ["labels", ["bug", "parser"], run.id],
      ["dueDate", "2026-02-01", run.id],
      ["estimate", 3, run.id],
    ]);
    expect(byAgent[0].actor).toEqual({ kind: "agent", id: agent.id, name: "claude-max" });
    // A User's Changes name no Run.
    expect(timeline[0]).toEqual(expect.objectContaining({ field: "created", runId: null }));
  });
});

describe("what an Agent may not edit", () => {
  const noRunningRun = {
    code: "no_running_run",
    message: expect.any(String),
    rule: "An Agent changes a Ticket, and writes Reports on it, only during its own running Run on that Ticket.",
    advice: expect.stringContaining("Comment"),
  };

  test("another Ticket than its Run's is refused with advice, and left unchanged", async () => {
    const { ada, other, asAgent } = await runningRun();

    const response = await call("PATCH", `/api/tickets/${other.id}`, asAgent, { priority: "urgent" });

    expect(response.status).toBe(403);
    expect(response.json.error).toEqual({ ...noRunningRun, message: "claude-max has no running Run on CRONK-2." });
    expect((await ok("GET", `/api/tickets/${other.id}`, ada)).priority).toBe("none");
  });

  test("its Ticket once the Run has finished is refused with advice", async () => {
    const { ada, ticket, run, asAgent } = await runningRun();
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    const response = await call("PATCH", `/api/tickets/${ticket.id}`, asAgent, { priority: "urgent" });

    expect(response.status).toBe(403);
    expect(response.json.error).toEqual(noRunningRun);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).priority).toBe("none");
  });

  test("an Agent connected by hand, with no Run, reads and comments but doesn't edit", async () => {
    const { workspace, ada, other } = await runningRun();
    const laptop = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "laptop-claude" });
    const { secret } = await ok("POST", `/api/agents/${laptop.id}/tokens`, ada, { name: "laptop", access: "full" });
    const byHand = { headers: { authorization: `Bearer ${secret}` } };

    expect((await call("GET", `/api/tickets/${other.id}`, byHand)).status).toBe(200);
    expect((await call("POST", `/api/tickets/${other.id}/comments`, byHand, { body: "Looked at it." })).status).toBe(201);
    const edit = await call("PATCH", `/api/tickets/${other.id}`, byHand, { description: "Mine now." });
    expect(edit.status).toBe(403);
    expect(edit.json.error).toEqual({ ...noRunningRun, message: "laptop-claude has no running Run on CRONK-2." });
  });

  test("its title, Assignee, Delegation and parent stay for Users, even during its Run", async () => {
    const { ada, ticket, other, agent, asAgent } = await runningRun();

    for (const edit of [
      { title: "Mine" },
      { assigneeId: null },
      { delegateId: null },
      { delegateId: agent.id },
      { parentId: other.id },
      { priority: "high", title: "Mine" },
    ]) {
      const response = await call("PATCH", `/api/tickets/${ticket.id}`, asAgent, edit);
      expect(response.status, JSON.stringify(edit)).toBe(403);
      expect(response.json.error, JSON.stringify(edit)).toEqual({
        code: "agent_field_not_allowed",
        message: expect.any(String),
        rule:
          "During its running Run, an Agent may edit its Ticket's description, Priority, Labels, due date and estimate, " +
          "and the title too of a Discovered Ticket it filed, until a User takes that up; " +
          "a Ticket's Assignee, Delegation, parent and Status are for Users to change.",
        advice: expect.stringContaining("ada@example.com"),
      });
    }
    const unchanged = await ok("GET", `/api/tickets/${ticket.id}`, ada);
    expect(unchanged).toEqual(
      expect.objectContaining({ title: "Make it so", priority: "none", delegateId: agent.id, parentId: null }),
    );
  });
});

describe("Reports", () => {
  test("an Agent writes Reports on its Ticket during its Run, listed with the Ticket oldest first", async () => {
    const { ada, ticket, agent, run, asAgent } = await runningRun();

    const written = await call("POST", `/api/tickets/${ticket.id}/reports`, asAgent, {
      title: "Findings",
      body: "The bug is in **parsing**.",
    });
    cronk.clock.advance(60_000);
    await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, { title: "Plan", body: "Fix the parser." });

    expect(written.status).toBe(201);
    const findings = {
      id: expect.any(String),
      ticketId: ticket.id,
      runId: run.id,
      agent: { id: agent.id, name: "claude-max" },
      title: "Findings",
      slug: expect.stringMatching(/^findings-[0-9a-f]{8}$/),
      body: "The bug is in **parsing**.",
      createdAt: "2026-01-01T09:00:00.000Z",
    };
    expect(written.json).toEqual(findings);
    const reports = await ok("GET", `/api/tickets/${ticket.id}/reports`, ada);
    expect(reports).toEqual([
      findings,
      { ...findings, title: "Plan", slug: expect.stringMatching(/^plan-[0-9a-f]{8}$/), body: "Fix the parser.", createdAt: "2026-01-01T09:01:00.000Z" },
    ]);
    // Agents read them too, as later Runs on the Ticket do.
    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, asAgent)).toEqual(reports);
  });

  test("an Agent writes no Report outside its running Run on the Ticket, and Users write none", async () => {
    const { ada, ticket, other, run, asAgent } = await runningRun();
    const report = { title: "Findings", body: "Nothing." };

    const onOther = await call("POST", `/api/tickets/${other.id}/reports`, asAgent, report);
    expect(onOther.status).toBe(403);
    expect(onOther.json.error).toEqual(expect.objectContaining({ code: "no_running_run", advice: expect.any(String) }));

    const byUser = await call("POST", `/api/tickets/${ticket.id}/reports`, ada, report);
    expect(byUser.status).toBe(403);
    expect(byUser.json.error.code).toBe("only_runs_report");

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    const afterRun = await call("POST", `/api/tickets/${ticket.id}/reports`, asAgent, report);
    expect(afterRun.status).toBe(403);
    expect(afterRun.json.error.code).toBe("no_running_run");
    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, ada)).toEqual([]);
  });

  test("finishing a Run with a Report adds it to the Ticket's Reports, titled after the Run's Step", async () => {
    const { ada, ticket, agent, run, asAgent } = await runningRun();

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready", report: "Clear enough to start." });

    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, ada)).toEqual([
      {
        id: expect.any(String),
        ticketId: ticket.id,
        runId: run.id,
        agent: { id: agent.id, name: "claude-max" },
        title: "Triage report",
        slug: expect.stringMatching(/^triage-report-[0-9a-f]{8}$/),
        body: "Clear enough to start.",
        createdAt: "2026-01-01T09:00:00.000Z",
      },
    ]);
  });

  test("a Report of only whitespace given to finish is refused", async () => {
    const { ada, ticket, run, asAgent } = await runningRun();

    const refused = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready", report: "  \n " });

    expect(refused.status).toBe(400);
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, ada)).toEqual([]);
  });

  test("a refused finish adds no Report", async () => {
    const { ada, ticket, run, asAgent } = await runningRun();

    const refused = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "approve", report: "Done." });

    expect(refused.status).toBe(400);
    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, ada)).toEqual([]);
  });

  test("a Report written tells the Workspace's streams", async () => {
    const { workspace, ada, project, ticket, asAgent } = await runningRun();
    const stream = await openStream(cronk, ada.cookie!, workspace.id);

    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, { title: "Findings", body: "…" });

    expect(await stream.next()).toEqual({
      type: "report.added",
      data: { projectId: project.id, ticketId: ticket.id, reportId: report.id },
    });
    stream.close();
  });
});

describe("a Run's last call", () => {
  test("its Agent's calls naming the Run or its Ticket record when it last called, refused ones too", async () => {
    const { workspace, ada, ticket, run, asAgent } = await runningRun();
    const lastCall = async () => (await ok("GET", `/api/runs/${run.id}`, ada)).lastCallAt;
    expect(await lastCall()).toBeNull();

    const minute = (n: number) => `2026-01-01T09:${String(n).padStart(2, "0")}:00.000Z`;
    const calls: [string, string, unknown?][] = [
      ["GET", `/api/tickets/${ticket.id}`],
      ["GET", `/api/workspaces/${workspace.id}/tickets/cronk-1`],
      ["POST", `/api/tickets/${ticket.id}/comments`, { body: "Starting." }],
      ["GET", `/api/runs/${run.id}/brief`],
      ["PATCH", `/api/tickets/${ticket.id}`, { title: "Refused" }],
      ["PATCH", `/api/tickets/${ticket.id}`, { priority: "whenever" }],
    ];
    for (const [i, [method, path, body]] of calls.entries()) {
      cronk.clock.advance(60_000);
      await call(method, path, asAgent, body);
      expect(await lastCall(), `${method} ${path}`).toBe(minute(i + 1));
    }
  });

  test("calls naming other Tickets, and calls by Users or other Agents, record nothing", async () => {
    const { workspace, ada, ticket, other, run, asAgent } = await runningRun();
    const bot = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "other-bot" });
    const { secret } = await ok("POST", `/api/agents/${bot.id}/tokens`, ada, { name: "cloud", access: "full" });
    cronk.clock.advance(60_000);

    await ok("GET", `/api/tickets/${other.id}`, asAgent);
    await ok("GET", `/api/workspaces/${workspace.id}/projects`, asAgent);
    await ok("GET", `/api/tickets/${ticket.id}`, ada);
    await ok("GET", `/api/tickets/${ticket.id}`, { headers: { authorization: `Bearer ${secret}` } });

    expect((await ok("GET", `/api/runs/${run.id}`, ada)).lastCallAt).toBeNull();
  });
});
