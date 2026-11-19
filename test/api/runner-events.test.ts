import { afterEach, beforeEach, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openRunnerStream, type OpenStream } from "../harness/stream.js";

let cronk: StartedCronk;
let streams: OpenStream[];
beforeEach(async () => {
  cronk = await startCronk();
  streams = [];
});
afterEach(async () => {
  for (const stream of streams) stream.close();
  await cronk?.stop();
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  const json = response.status === 204 ? null : await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
}

async function runnerStream(cookie: string) {
  const stream = await openRunnerStream(cronk, cookie);
  streams.push(stream);
  return stream;
}

/** Ada with a delegated Ticket in Backlog, her Agent `claude-max` using her fake Runner. */
async function adaWithDelegatedTicket() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  return { workspace, ada, ticket, runner, asAgent: { headers: { authorization: `Bearer ${secret}` } }, status };
}

test("a Run starting on a Runner tells its Owner's stream which Runner changed", async () => {
  const { ada, ticket, runner, status } = await adaWithDelegatedTicket();
  const stream = await runnerStream(ada.cookie);

  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

  expect(await stream.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });
  const [shown] = await ok("GET", "/api/runners", ada);
  expect(shown.running).toBe(1);
});

test("a Run finishing on a Runner tells its Owner's stream which Runner changed", async () => {
  const { ada, ticket, runner, asAgent, status } = await adaWithDelegatedTicket();
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const stream = await runnerStream(ada.cookie);

  await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

  expect(await stream.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });
  const [shown] = await ok("GET", "/api/runners", ada);
  expect(shown.running).toBe(0);
});

test("a Runner paused for a rate limit, and resumed, tells its Owner's stream", async () => {
  const { ada, ticket, runner, status } = await adaWithDelegatedTicket();
  const stream = await runnerStream(ada.cookie);
  cronk.runner.refuseNext({ kind: "rate_limited", message: "Too many fires.", retryAt: new Date("2026-01-01T10:00:00Z") });

  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

  // The Run is recorded, then unrecorded once the Runner answers with its rate limit, pausing its queue.
  expect(await stream.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });
  expect(await stream.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });
  const [paused] = await ok("GET", "/api/runners", ada);
  expect(paused).toMatchObject({ running: 0, pausedUntil: "2026-01-01T10:00:00.000Z" });

  // Nothing waits for this Runner once the Ticket has moved on, so resuming starts no Run: only the pause ends.
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Ready") });
  cronk.clock.advance(60 * 60 * 1000);
  await cronk.resumePausedRunners();

  expect(await stream.next()).toEqual({ type: "runner.changed", data: { runnerId: runner.id } });
  const [resumed] = await ok("GET", "/api/runners", ada);
  expect(resumed).toMatchObject({ running: 0, pausedUntil: null });
});

test("a Runner's changes reach only its Owner's stream", async () => {
  const { workspace, ada, ticket, status } = await adaWithDelegatedTicket();
  const bob = await addMember(cronk, ada.cookie, workspace.id, "bob@example.com");
  const bobs = await runnerStream(bob.cookie);

  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Triage") });

  await bobs.expectQuiet();
});
