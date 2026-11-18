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

const minutes = (n: number) => n * 60 * 1000;

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
  const inbox = (as: Request = ada) => ok("GET", `/api/workspaces/${workspace.id}/inbox`, as);
  return { workspace, user, ada, project, ticket, runner, agent, asAgent: { headers: { authorization: `Bearer ${secret}` } }, status, inbox };
}

/** Ada's Ticket, delegated to her Agent and in Triage, with its running Run. */
async function runningRun() {
  const setup = await adaWithAgent();
  const { ada, ticket, agent, status } = setup;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await runsOf(ticket.id, ada);
  return { ...setup, run };
}

const runsOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}/runs`, as);
const states = async (ticketId: string, as: Request) =>
  (await runsOf(ticketId, as)).map((r: { step: { name: string }; state: string }) => [r.step.name, r.state]);

describe("failed Runs", () => {
  test("a Run its Runner reports ended without finishing puts its Ticket in the Delegate's Owner's Inbox, where it stays", async () => {
    const { ada, ticket, run, status, inbox } = await runningRun();

    await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");

    expect(await inbox()).toEqual({
      count: 1,
      items: [
        {
          kind: "run",
          ticket: expect.objectContaining({ id: ticket.id, key: "CRONK-1", statusId: status("Triage") }),
          run: {
            id: run.id,
            state: "failed",
            step: { statusId: status("Triage"), name: "Triage" },
            endReason: "The session crashed.",
          },
        },
      ],
    });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Triage"));
  });
});

describe("Runs that couldn't start", () => {
  test("a Runner refusing to start a Run puts its Ticket in the Inbox with the reason, and nobody else's", async () => {
    const { workspace, ada, ticket, agent, status, inbox } = await adaWithAgent();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    cronk.runner.refuseNext({ kind: "credentials_rejected", message: "The trigger's token was rejected." });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const { items } = await inbox();
    expect(items).toEqual([
      expect.objectContaining({
        kind: "run",
        run: expect.objectContaining({ state: "refused", endReason: "The trigger's token was rejected." }),
      }),
    ]);
    expect(await inbox({ cookie: bea.cookie })).toEqual({ count: 0, items: [] });
  });

  test("moving the Ticket on takes it out of the Inbox", async () => {
    const { ada, ticket, agent, status, inbox } = await adaWithAgent();
    cronk.runner.refuseNext({ kind: "not_configured", message: "No trigger for haiku." });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    expect((await inbox()).count).toBe(1);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });

    expect(await inbox()).toEqual({ count: 0, items: [] });
  });
});

describe("rate limits", () => {
  test("a Runner that is rate limited leaves the Ticket waiting, not couldn't-start, and out of the Inbox", async () => {
    const { ada, ticket, agent, status, inbox } = await adaWithAgent();
    cronk.runner.refuseNext({ kind: "rate_limited", message: "Too many fires.", retryAt: new Date("2026-01-01T10:00:00Z") });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect(cronk.runner.starts).toHaveLength(1);
    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).lastRun).toBeNull();
    expect(await inbox()).toEqual({ count: 0, items: [] });
  });
});

describe("Retry", () => {
  test("starts a fresh Run of the same Step, taking the Ticket out of the Inbox", async () => {
    const { ada, ticket, run, status, inbox } = await runningRun();
    await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");

    const retried = await call("POST", `/api/tickets/${ticket.id}/retry`, ada);

    expect(retried.status).toBe(201);
    expect(retried.json).toEqual(
      expect.objectContaining({ step: { statusId: status("Triage"), name: "Triage" }, model: "haiku", state: "running" }),
    );
    expect(retried.json.id).not.toBe(run.id);
    expect(await states(ticket.id, ada)).toEqual([
      ["Triage", "failed"],
      ["Triage", "running"],
    ]);
    expect(cronk.runner.starts.map((s) => s.runId)).toEqual([run.id, retried.json.id]);
    expect(await inbox()).toEqual({ count: 0, items: [] });
  });

  test("works for a Run that couldn't start", async () => {
    const { ada, ticket, agent, status } = await adaWithAgent();
    cronk.runner.refuseNext({ kind: "not_configured", message: "No trigger for haiku." });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    await ok("POST", `/api/tickets/${ticket.id}/retry`, ada);

    expect(await states(ticket.id, ada)).toEqual([
      ["Triage", "refused"],
      ["Triage", "running"],
    ]);
  });

  test("is refused while a Run is running, after one finished, and for Agents", async () => {
    const { ada, ticket, run, asAgent } = await runningRun();

    const whileRunning = await call("POST", `/api/tickets/${ticket.id}/retry`, ada);
    expect(whileRunning.status).toBe(409);
    expect(whileRunning.json.error.code).toBe("nothing_to_retry");

    await cronk.runner.endWithoutFinishing(run.id);
    expect((await call("POST", `/api/tickets/${ticket.id}/retry`, asAgent)).status).toBe(403);

    await ok("POST", `/api/tickets/${ticket.id}/retry`, ada);
    const [, second] = await runsOf(ticket.id, ada);
    await ok("POST", `/api/runs/${second.id}/finish`, asAgent, { outcome: "ready" });
    expect((await call("POST", `/api/tickets/${ticket.id}/retry`, ada)).json.error.code).toBe("nothing_to_retry");
    expect(cronk.runner.starts).toHaveLength(2);
  });

  test("is refused once the Ticket left the Status of the Run that went wrong", async () => {
    const { ada, ticket, run, status } = await runningRun();
    await cronk.runner.endWithoutFinishing(run.id);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });

    const response = await call("POST", `/api/tickets/${ticket.id}/retry`, ada);

    expect(response.status).toBe(409);
    expect(response.json.error.code).toBe("nothing_to_retry");
    expect(cronk.runner.starts).toHaveLength(1);
  });
});
