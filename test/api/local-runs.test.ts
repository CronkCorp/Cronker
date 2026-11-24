import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defaultAllowedTools } from "../../server/runs/allowlist.js";
import { minutes } from "../harness/clock.js";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openMachineStream, type OpenStream } from "../harness/stream.js";

/**
 * Seam 1 for local Runs: a real Cronk with the `local` Runner kind, and the daemon played over HTTP with a Machine
 * token. Delegating starts a claimable Run, a Machine claims it once, heartbeats it and reports how it ended.
 */

let cronk: StartedCronk;
const streams: OpenStream[] = [];
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  streams.splice(0).forEach((s) => s.close());
  await cronk?.stop();
});

type Options = { cookie?: string; body?: unknown; token?: string };

async function call(method: string, path: string, options: Options = {}) {
  const response = await cronk.request(method, path, {
    cookie: options.cookie,
    body: options.body,
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, options: Options = {}) {
  const response = await call(method, path, options);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

async function pair(ada: string, runnerIds: string[], limit?: number) {
  const started = await ok("POST", "/api/machines/pairings", {
    body: { name: "ada-laptop", os: "linux", daemonVersion: "0.3.0", ...(limit ? { limit } : {}) },
  });
  await ok("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds } });
  const paired = await ok("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } });
  return paired.machineToken as string;
}

/** Ada with a `local` Runner, an Agent on it, a Project with Tickets, and a Machine serving the Runner. */
async function localSetUp({ runLimit = 1, machineLimit }: { runLimit?: number; machineLimit?: number } = {}) {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Laptop", kind: "local" } });
  if (runLimit !== 1) await ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { runLimit } });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { cookie: ada, body: { name: "laptop" } });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, { cookie: ada, body: { runnerId: runner.id } });
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, { cookie: ada, body: { name: "Cronker", key: "CRONK" } });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  const machineToken = await pair(ada, [runner.id], machineLimit);
  /** Files a Ticket and delegates it into Triage, answering its Run. */
  const delegate = async (title: string, labels: string[] = []) => {
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, { cookie: ada, body: { title, labels } });
    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: agent.id, statusId: triage } });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, { cookie: ada });
    return { ticket, run };
  };
  return { workspace, ada, runner, agent, project, machineToken, delegate };
}

const claim = (token: string, runId: string) => call("POST", `/api/machine/runs/${runId}/claim`, { token });

describe("claiming a local Run", () => {
  test("a connected Machine hears of the Run as it starts and claims it with what claude needs", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);

    const { run } = await delegate("Touch the laptop", ["local-only"]);

    expect(run.state).toBe("running");
    expect(await stream.next()).toEqual({ type: "run.claimable", data: { runId: run.id } });
    const claimed = await claim(machineToken, run.id);
    expect(claimed.status).toBe(200);
    const brief = await ok("GET", `/api/runs/${run.id}/brief`, { cookie: ada });
    expect(claimed.json).toEqual({
      runId: run.id,
      ticketKey: "CRONK-1",
      brief: brief.text,
      modelId: "claude-haiku-5-5",
      token: expect.stringMatching(/^cronk_agent_/),
      mcpUrl: `${cronk.url}/mcp`,
      allowedTools: [...defaultAllowedTools],
    });
  });

  test("a Machine connecting later is told of the Runs already waiting", async () => {
    const { machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Waiting");

    const stream = await openMachineStream(cronk, machineToken);
    streams.push(stream);

    expect(await stream.next()).toEqual({ type: "run.claimable", data: { runId: run.id } });
  });

  test("two claims of one Run grant it once", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Race");

    const [first, second] = await Promise.all([claim(machineToken, run.id), claim(other, run.id)]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect([first, second].find((c) => c.status === 409)!.json.error.code).toBe("run_not_claimable");
    expect((await claim(machineToken, run.id)).status).toBe(409);
  });

  test("a Machine claims no more Runs at once than its limit", async () => {
    const { machineToken, delegate } = await localSetUp({ runLimit: 2, machineLimit: 1 });
    const { run: first } = await delegate("One");
    const { run: second } = await delegate("Two");
    expect(second.state).toBe("running");

    expect((await claim(machineToken, first.id)).status).toBe(200);
    const refused = await claim(machineToken, second.id);

    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("machine_limit_reached");
  });

  test("a Machine can't claim a Run of a Runner it doesn't serve", async () => {
    const { ada, delegate } = await localSetUp();
    const elsewhere = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Desktop", kind: "local" } });
    const stranger = await pair(ada, [elsewhere.id]);
    const { run } = await delegate("Not yours");

    expect((await claim(stranger, run.id)).status).toBe(404);
    expect((await claim("cronk_machine_nonsense", run.id)).status).toBe(401);
  });

  test("a Step whose model label has no model id is refused, saying why", async () => {
    const { workspace, ada, delegate } = await localSetUp();
    await ok("DELETE", `/api/workspaces/${workspace.id}/model-ids/haiku`, { cookie: ada });

    const { run } = await delegate("No model");

    const refused = await ok("GET", `/api/runs/${run.id}`, { cookie: ada });
    expect(refused.state).toBe("refused");
    expect(refused.endReason).toContain("no model id for the label haiku");
  });
});

describe("the Run's token", () => {
  test("acts as the Run's Agent, finishes the Run, and is revoked once it ends", async () => {
    const { ada, agent, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Finish me");
    const { token } = (await claim(machineToken, run.id)).json;

    expect((await ok("GET", "/api/agent", { token })).agent.id).toBe(agent.id);
    const finished = await ok("POST", `/api/runs/${run.id}/finish`, { token, body: { outcome: "ready" } });
    expect(finished.state).toBe("finished");

    await cronk.jobsSettled();
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    // The process exiting afterwards changes nothing.
    await ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude exited with code 0" } });
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("finished");
  });

  test("is revoked when a User takes the Ticket away, and the heartbeat says the Run stopped", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Take it back");
    const { token } = (await claim(machineToken, run.id)).json;

    await ok("PATCH", `/api/tickets/${ticket.id}`, { cookie: ada, body: { delegateId: null } });
    await cronk.jobsSettled();

    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
    const beat = await call("POST", `/api/machine/runs/${run.id}/heartbeat`, { token: machineToken });
    expect(beat.status).toBe(409);
    expect(beat.json.error.code).toBe("run_stopped");
  });
});

describe("a claimed Run", () => {
  test("takes the session id the daemon reports while it runs, and none after", async () => {
    const { machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Session");
    await claim(machineToken, run.id);
    const report = () => call("POST", `/api/machine/runs/${run.id}/session`, { token: machineToken, body: { sessionId: "4f1c2b9e" } });

    expect((await report()).status).toBe(204);
    await ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude exited with code 1" } });
    expect((await report()).json.error.code).toBe("run_stopped");
  });

  test("heartbeats keep it running past the lost-Run threshold; without them it is lost", async () => {
    const { ada, machineToken, delegate } = await localSetUp({ runLimit: 2 });
    const { run: beating } = await delegate("Beating");
    const { run: silent } = await delegate("Silent");
    await claim(machineToken, beating.id);
    await claim(machineToken, silent.id);

    for (let i = 0; i < 4; i++) {
      cronk.clock.advance(minutes(10));
      await ok("POST", `/api/machine/runs/${beating.id}/heartbeat`, { token: machineToken });
      await cronk.checkForLostRuns();
    }

    expect((await ok("GET", `/api/runs/${beating.id}`, { cookie: ada })).state).toBe("running");
    expect((await ok("GET", `/api/runs/${silent.id}`, { cookie: ada })).state).toBe("lost");
  });

  test("whose process exits without finish fails with the reason, and its token is revoked", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Crash");
    const { token } = (await claim(machineToken, run.id)).json;

    await ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude exited with code 1" } });
    await cronk.jobsSettled();

    expect(await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).toEqual(
      expect.objectContaining({ state: "failed", endReason: "The session ended without calling `finish`: claude exited with code 1" }),
    );
    expect((await call("GET", "/api/agent", { token })).status).toBe(401);
  });

  test("only the Machine that claimed it reports on it", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Mine");
    await claim(machineToken, run.id);

    for (const path of ["heartbeat", "end"]) {
      const response = await call("POST", `/api/machine/runs/${run.id}/${path}`, { token: other, body: { reason: "no" } });
      expect(response.status).toBe(404);
    }
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).state).toBe("running");
  });
});

describe("a local Runner's allowlist", () => {
  test("a new local Runner has the default, which includes git, package managers, test runners and Cronk's tools", async () => {
    const { runner } = await localSetUp();

    expect(runner.allowedTools).toEqual([...defaultAllowedTools]);
    expect(runner.allowedTools).toEqual(expect.arrayContaining(["Bash(git:*)", "Bash(npm:*)", "Bash(pytest:*)", "mcp__cronk"]));
  });

  test("its User edits it, trimmed and without repeats, and it applies to the Runs claimed from then on", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp({ runLimit: 2, machineLimit: 2 });
    const { run: before } = await delegate("Before");
    const beforeClaim = await claim(machineToken, before.id);

    const { run: after } = await delegate("After");
    const edited = await ok("PATCH", `/api/runners/${runner.id}`, {
      cookie: ada,
      body: { allowedTools: [" Bash(git:*) ", "Bash(cargo test:*)", "Bash(git:*)"] },
    });

    expect(edited.allowedTools).toEqual(["Bash(git:*)", "Bash(cargo test:*)"]);
    expect((await ok("GET", "/api/runners", { cookie: ada }))[0].allowedTools).toEqual(["Bash(git:*)", "Bash(cargo test:*)"]);
    expect(beforeClaim.json.allowedTools).toEqual([...defaultAllowedTools]);
    expect((await claim(machineToken, after.id)).json.allowedTools).toEqual(["Bash(git:*)", "Bash(cargo test:*)"]);

    const reset = await ok("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { allowedTools: null } });
    expect(reset.allowedTools).toEqual([...defaultAllowedTools]);
  });

  test("an empty or overlong rule is refused, and a Runner of another kind has none", async () => {
    const { ada, runner } = await localSetUp();
    for (const allowedTools of [[" "], ["x".repeat(201)], Array.from({ length: 201 }, (_, i) => `Bash(tool${i}:*)`)]) {
      const refused = await call("PATCH", `/api/runners/${runner.id}`, { cookie: ada, body: { allowedTools } });
      expect(refused.status).toBe(400);
    }

    const cloud = await ok("POST", "/api/runners", { cookie: ada, body: { name: "Max", kind: "subscription" } });
    expect(cloud.allowedTools).toBeNull();
    const refused = await call("PATCH", `/api/runners/${cloud.id}`, { cookie: ada, body: { allowedTools: ["Bash(git:*)"] } });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("runner_has_no_allowlist");
  });

  test("a Run whose process ended on tools outside the list fails naming them", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Publish");
    await claim(machineToken, run.id);

    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 0", deniedTools: ["Bash(npm publish)", "WebFetch"] },
    });
    await cronk.jobsSettled();

    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).endReason).toBe(
      "The session ended without calling `finish`: claude exited with code 0. It needed tools outside the Runner's " +
        "allowlist: Bash(npm publish), WebFetch; widen the allowlist and Retry.",
    );
  });
});

/** A Claude Code transcript of `count` user messages, its JSONL file as it is. */
const jsonl = (count: number) =>
  Array.from({ length: count }, (_, i) =>
    JSON.stringify({ type: "user", uuid: `u-${i}`, timestamp: "2026-01-01T09:00:00.000Z", message: { role: "user", content: `Message ${i}.` } }),
  ).join("\n") + "\n";

/** Uploads a claimed Run's transcript with the Machine token, as the daemon does. */
async function uploadTranscript(token: string, runId: string, body: string) {
  const response = await fetch(`${cronk.url}/api/machine/runs/${runId}/transcript`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${token}` },
    body,
  });
  return { status: response.status, json: await response.json() };
}

describe("a local Run's transcript", () => {
  test("uploaded by its Machine becomes the Run's Transcript, replaced by each later upload, even after the Run ended", async () => {
    const { ada, agent, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Transcribe me");
    const { token } = (await claim(machineToken, run.id)).json;
    await ok("POST", `/api/machine/runs/${run.id}/session`, { token: machineToken, body: { sessionId: "4f1c2b9e" } });

    const first = await uploadTranscript(machineToken, run.id, jsonl(1));
    expect(first.status).toBe(201);
    expect(first.json).toEqual(expect.objectContaining({ runId: run.id, entryCount: 1, agent: { id: agent.id, name: "laptop" } }));
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).transcriptId).toBe(first.json.id);

    // The agent finishes: the Run's own token is revoked, but the Machine's last upload still lands.
    await ok("POST", `/api/runs/${run.id}/finish`, { token, body: { outcome: "ready" } });
    await cronk.jobsSettled();
    const last = await uploadTranscript(machineToken, run.id, jsonl(3));

    expect(last.status).toBe(200);
    expect(last.json).toEqual(expect.objectContaining({ id: first.json.id, runId: run.id, entryCount: 3 }));
  });

  test("is refused before the Run's session is reported, and for a Run the Machine doesn't hold", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const other = await pair(ada, [runner.id]);
    const { run } = await delegate("Too soon");
    await claim(machineToken, run.id);

    const early = await uploadTranscript(machineToken, run.id, jsonl(1));
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("no_session");

    await ok("POST", `/api/machine/runs/${run.id}/session`, { token: machineToken, body: { sessionId: "4f1c2b9e" } });
    expect((await uploadTranscript(other, run.id, jsonl(1))).status).toBe(404);
  });

  test("stops being kept once a User deleted it", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { run } = await delegate("Secret");
    await claim(machineToken, run.id);
    await ok("POST", `/api/machine/runs/${run.id}/session`, { token: machineToken, body: { sessionId: "4f1c2b9e" } });
    const { json: transcript } = await uploadTranscript(machineToken, run.id, jsonl(1));

    await ok("DELETE", `/api/transcripts/${transcript.id}`, { cookie: ada });
    const refused = await uploadTranscript(machineToken, run.id, jsonl(2));

    expect(refused.status).toBe(410);
    expect(refused.json.error.code).toBe("transcript_deleted");
  });
});

describe("a local Run's cost", () => {
  test("reported with its end is recorded as an estimate, on the Run, its Ticket's total and its Runner's month", async () => {
    const { ada, runner, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Costly");
    const { token } = (await claim(machineToken, run.id)).json;
    await ok("POST", `/api/runs/${run.id}/finish`, { token, body: { outcome: "ready" } });

    await ok("POST", `/api/machine/runs/${run.id}/end`, {
      token: machineToken,
      body: { reason: "claude exited with code 0", costUsd: 1.234 },
    });

    const estimate = { amount: 123, currency: "USD", estimate: true };
    expect((await ok("GET", `/api/runs/${run.id}`, { cookie: ada })).cost).toEqual(estimate);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, { cookie: ada })).cost).toEqual([estimate]);
    const runners = await ok("GET", "/api/runners", { cookie: ada });
    expect(runners.find((r: { id: string }) => r.id === runner.id).costThisMonth).toEqual([estimate]);
  });

  test("of a Run that failed is recorded too, and an end without one records none", async () => {
    const { ada, machineToken, delegate } = await localSetUp({ runLimit: 2 });
    const { run: failed } = await delegate("Failed");
    const { run: silent } = await delegate("Silent");
    await claim(machineToken, failed.id);
    await claim(machineToken, silent.id);

    await ok("POST", `/api/machine/runs/${failed.id}/end`, { token: machineToken, body: { reason: "claude exited with code 1", costUsd: 0.5 } });
    await ok("POST", `/api/machine/runs/${silent.id}/end`, { token: machineToken, body: { reason: "claude was killed by SIGKILL" } });

    const failedRun = await ok("GET", `/api/runs/${failed.id}`, { cookie: ada });
    expect(failedRun).toEqual(expect.objectContaining({ state: "failed", cost: { amount: 50, currency: "USD", estimate: true } }));
    expect((await ok("GET", `/api/runs/${silent.id}`, { cookie: ada })).cost).toBeNull();
  });

  test("estimates stay apart from real costs in a Ticket's total", async () => {
    const { ada, machineToken, delegate } = await localSetUp();
    const { ticket, run } = await delegate("Mixed");
    await claim(machineToken, run.id);
    await ok("POST", `/api/machine/runs/${run.id}/end`, { token: machineToken, body: { reason: "claude exited with code 1", costUsd: 0.25 } });
    // A real cost on the same Ticket, as a Managed Agents session reports one.
    await cronk.stage(
      `insert into runs (id, workspace_id, ticket_id, agent_id, status_id, status_name, model, brief, state, started_at, ended_at, cost_amount, cost_currency)
       select gen_random_uuid(), workspace_id, ticket_id, agent_id, status_id, status_name, model, brief, 'failed', started_at, ended_at, 300, 'USD'
       from runs where id = $1`,
      [run.id],
    );

    expect((await ok("GET", `/api/tickets/${ticket.id}`, { cookie: ada })).cost).toEqual([
      { amount: 300, currency: "USD", estimate: false },
      { amount: 25, currency: "USD", estimate: true },
    ]);
  });
});
