import { afterEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk, type StartCronkOptions } from "../harness/start-cronk.js";

let cronk: StartedCronk | undefined;
afterEach(async () => {
  await cronk?.stop();
  cronk = undefined;
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk!.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/**
 * Ada with a Project on the default board and a Ticket CRONK-1 her Agent `claude-max` is running a Triage Run on,
 * through her fake Runner.
 */
async function runningRun(options: StartCronkOptions = {}) {
  cronk = await startCronk(options);
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, ada, project, ticket, agent, run, asAgent };
}

describe("milestone 1's Reports moved into Documents", () => {
  test("each Report survives with its title, body, Agent, Run and time, as a Document with one Version by its Agent", async () => {
    const { ada, project, ticket, agent, run } = await runningRun({ migrateBefore: "0022_reports_documents.sql" });
    // Two Reports milestone 1 wrote at the same instant, which keep the order they were written in.
    const findings = "8c1f5a52-6f0e-4a8e-9d43-1b2c3d4e5f60";
    const plan = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";
    for (const [id, title, body] of [
      [findings, "Findings", "The bug is in **parsing**."],
      [plan, "Plan", "Fix the parser."],
    ]) {
      await cronk!.stage(
        `insert into reports (id, workspace_id, ticket_id, run_id, agent_id, title, body, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, '2026-01-01T09:30:00Z')`,
        [id, project.workspaceId, ticket.id, run.id, agent.id, title, body],
      );
    }

    await cronk!.upgrade();

    const byAgent = { id: agent.id, name: "claude-max" };
    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, ada)).toEqual([
      {
        id: findings,
        ticketId: ticket.id,
        runId: run.id,
        agent: byAgent,
        title: "Findings",
        body: "The bug is in **parsing**.",
        createdAt: "2026-01-01T09:30:00.000Z",
      },
      {
        id: plan,
        ticketId: ticket.id,
        runId: run.id,
        agent: byAgent,
        title: "Plan",
        body: "Fix the parser.",
        createdAt: "2026-01-01T09:30:00.000Z",
      },
    ]);
    expect(await ok("GET", `/api/documents/${findings}/versions`, ada)).toEqual([
      { number: 1, title: "Findings", actor: { kind: "agent", ...byAgent }, savedAt: "2026-01-01T09:30:00.000Z" },
    ]);
    // Listed with the Ticket instead of in a page tree.
    expect(await ok("GET", `/api/projects/${project.id}/documents`, ada)).toEqual([]);
  });
});
