import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { minutes } from "../harness/clock.js";
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

const apiKey = "sk-ant-api03-ada-secret";

/**
 * Ada with a Project on the default board (Triage wants haiku), a Ticket in Backlog, and her Agent `claude-api`
 * using her Managed Agents Runner, set up with a key Anthropic accepts.
 */
async function adaWithManagedAgentsRunner() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  cronk.managedAgents.apiKey(apiKey);
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Claude API", kind: "managed_agents", apiKey });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-api" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const inbox = () => ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
  /** Delegates the Ticket and moves it into the Status, starting a Run there; returns the Run and its session. */
  const startRun = async (statusName = "Triage", on = ticket) => {
    await ok("PATCH", `/api/tickets/${on.id}`, ada, { delegateId: agent.id, statusId: status(statusName) });
    const runs = await runsOf(on.id, ada);
    const run = runs[runs.length - 1];
    const session = cronk.managedAgents.sessions[cronk.managedAgents.sessions.length - 1]!;
    return { run, session };
  };
  return { workspace, ada, project, ticket, runner, agent, status, inbox, startRun };
}

const runsOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}/runs`, as);

/** The bearer token the session's vault holds for Cronk's MCP server. */
function tokenInVault(vaultId: string): string {
  const vault = cronk.managedAgents.vaults.find((v) => v.id === vaultId)!;
  return ((vault.credentials[0]!.body.auth as Record<string, unknown>).token as string) ?? "";
}

describe("setting up a Managed Agents Runner", () => {
  test("with a valid API key creates one agent with Cronk's MCP server and one cloud environment in the key's workspace", async () => {
    await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };
    cronk.managedAgents.apiKey(apiKey);

    const runner = await ok("POST", "/api/runners", ada, { name: "Claude API", kind: "managed_agents", apiKey });

    expect(cronk.managedAgents.agents).toHaveLength(1);
    expect(cronk.managedAgents.environments).toHaveLength(1);
    const [agent] = cronk.managedAgents.agents;
    const [environment] = cronk.managedAgents.environments;
    expect(agent!.apiKey).toBe(apiKey);
    expect(agent!.body.mcp_servers).toEqual([{ type: "url", name: "cronk", url: `${cronk.url}/mcp` }]);
    // Default tools and Cronk's tools run without asking: an unattended Run can't answer a confirmation.
    expect(agent!.body.tools).toEqual([
      { type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: { type: "always_allow" } } },
      { type: "mcp_toolset", mcp_server_name: "cronk", default_config: { permission_policy: { type: "always_allow" } } },
    ]);
    expect(environment!.apiKey).toBe(apiKey);
    expect((environment!.body.config as { type: string }).type).toBe("cloud");
    expect(runner).toEqual(
      expect.objectContaining({
        name: "Claude API",
        kind: "managed_agents",
        managedAgents: {
          agentId: agent!.id,
          environmentId: environment!.id,
          webhookUrl: `${cronk.url}/api/runners/${runner.id}/managed-agents/webhook`,
          webhookSecretSaved: false,
        },
      }),
    );
    expect(JSON.stringify(await ok("GET", "/api/runners", ada))).not.toContain(apiKey);
  });

  test("with a key Anthropic rejects is refused at once, and no Runner is set up", async () => {
    await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };

    const refused = await call("POST", "/api/runners", ada, { name: "Claude API", kind: "managed_agents", apiKey: "sk-ant-wrong" });

    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe("api_key_rejected");
    expect(await ok("GET", "/api/runners", ada)).toEqual([]);
  });

  test("that fails once the agent is made leaves no agent behind: it is archived", async () => {
    await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };
    cronk.managedAgents.apiKey(apiKey);
    cronk.managedAgents.failNext("POST", "/v1/environments", 500);

    const refused = await call("POST", "/api/runners", ada, { name: "Claude API", kind: "managed_agents", apiKey });

    expect(refused.status).toBe(502);
    expect(cronk.managedAgents.agents.map((a) => a.archived)).toEqual([true]);
    expect(await ok("GET", "/api/runners", ada)).toEqual([]);
  });

  test("without a key is refused", async () => {
    await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };

    const refused = await call("POST", "/api/runners", ada, { name: "Claude API", kind: "managed_agents" });

    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe("api_key_required");
  });
});

describe("starting a Run", () => {
  test("starts a session of the agent with the Step's model, the Brief as its first message and a vault of its own", async () => {
    const { ada, runner, startRun } = await adaWithManagedAgentsRunner();

    const { run, session } = await startRun();

    const brief = await ok("GET", `/api/runs/${run.id}/brief`, ada);
    expect(session.body.agent).toEqual({ type: "agent_with_overrides", id: runner.managedAgents.agentId, model: { id: "claude-haiku-5-5" } });
    expect(session.body.environment_id).toBe(runner.managedAgents.environmentId);
    expect(session.body.initial_events).toEqual([{ type: "user.message", content: [{ type: "text", text: brief.text }] }]);
    expect(session.body.vault_ids).toHaveLength(1);
    const [vault] = cronk.managedAgents.vaults;
    expect(session.body.vault_ids).toEqual([vault!.id]);
    expect(vault!.credentials).toHaveLength(1);
    expect(vault!.credentials[0]!.body.auth).toEqual(
      expect.objectContaining({ type: "static_bearer", mcp_server_url: `${cronk.url}/mcp` }),
    );
    expect(run).toEqual(
      expect.objectContaining({
        state: "running",
        model: "haiku",
        sessionUrl: `https://platform.claude.com/workspaces/default/sessions/${session.id}`,
      }),
    );
    expect(JSON.stringify(session.body)).not.toContain(tokenInVault(vault!.id));
  });

  test("the vault's token acts as the Run's Agent, and the Brief carries no token", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();

    const { run, session } = await startRun();

    const token = tokenInVault((session.body.vault_ids as string[])[0]!);
    const asAgent = { headers: { authorization: `Bearer ${token}` } };
    expect((await ok("GET", `/api/runs/${run.id}`, asAgent)).id).toBe(run.id);
    const brief = await ok("GET", `/api/runs/${run.id}/brief`, ada);
    expect(brief.text).not.toContain(token);
  });

  test("each Run that runs at once gets its own vault and token", async () => {
    const { ada, project, runner, startRun } = await adaWithManagedAgentsRunner();
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "And this" });

    await startRun();
    await startRun("Triage", other);

    expect((await ok("GET", "/api/runners", ada))[0].running).toBe(2);
    expect(runner.limit).toBe(2);
    const [first, second] = cronk.managedAgents.sessions;
    expect(first!.body.vault_ids).not.toEqual(second!.body.vault_ids);
    expect(tokenInVault((first!.body.vault_ids as string[])[0]!)).not.toBe(tokenInVault((second!.body.vault_ids as string[])[0]!));
  });

  test("passes the model id a Step names in full", async () => {
    const { ada, project, status, startRun } = await adaWithManagedAgentsRunner();
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage");
    const { statusId: _s, ...step } = triage.step;
    await ok("PUT", `/api/projects/${project.id}/statuses/${status("Triage")}/step`, ada, { ...step, model: "claude-opus-4-8" });

    const { session } = await startRun();

    expect((session.body.agent as { model: unknown }).model).toEqual({ id: "claude-opus-4-8" });
  });
});

describe("ending a Run", () => {
  test("a Run that calls finish ends finished: its session is archived, never deleted, its token revoked and its vault deleted", async () => {
    const { startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    const vaultId = (session.body.vault_ids as string[])[0]!;
    const asAgent = { headers: { authorization: `Bearer ${tokenInVault(vaultId)}` } };

    const finished = await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    expect(finished.state).toBe("finished");
    expect(cronk.managedAgents.session(session.id)).toEqual(expect.objectContaining({ archived: true, deleted: false }));
    expect(cronk.managedAgents.vaults.find((v) => v.id === vaultId)!.deleted).toBe(true);
    expect((await call("GET", `/api/runs/${run.id}`, asAgent)).status).toBe(401);
  });

  test("what Anthropic couldn't take when the Run ended is let go of by the next poll; the token is revoked at once", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    const vaultId = (session.body.vault_ids as string[])[0]!;
    const asAgent = { headers: { authorization: `Bearer ${tokenInVault(vaultId)}` } };
    cronk.managedAgents.failNext("DELETE", `/v1/vaults/${vaultId}`, 503);
    cronk.managedAgents.failNext("POST", `/v1/sessions/${session.id}/archive`, 503);

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    expect((await call("GET", `/api/runs/${run.id}`, asAgent)).status).toBe(401);
    expect(cronk.managedAgents.vaults.find((v) => v.id === vaultId)!.deleted).toBe(false);
    expect(cronk.managedAgents.session(session.id).archived).toBe(false);

    await cronk.pollManagedAgentsSessions();

    expect(cronk.managedAgents.vaults.find((v) => v.id === vaultId)!.deleted).toBe(true);
    expect(cronk.managedAgents.session(session.id)).toEqual(expect.objectContaining({ archived: true, deleted: false }));
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("finished");
  });

  test("a 429 after its vault was made lets go of the vault and the token, and the Ticket waits", async () => {
    const { ada, ticket, agent, status } = await adaWithManagedAgentsRunner();
    cronk.managedAgents.failNext("POST", "/v1/sessions", 429);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect(cronk.managedAgents.vaults.map((v) => v.deleted)).toEqual([true]);
    expect(await ok("GET", `/api/agents/${agent.id}/tokens`, ada)).toEqual([]);
  });

  test("stopping a Run sends its session user.interrupt, then archives it, and revokes its token", async () => {
    const { ada, ticket, status, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    const vaultId = (session.body.vault_ids as string[])[0]!;
    const asAgent = { headers: { authorization: `Bearer ${tokenInVault(vaultId)}` } };

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Backlog") });

    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("stopped");
    const sent = cronk.managedAgents.calls.filter((c) => c.method === "POST" && c.path.startsWith(`/v1/sessions/${session.id}/`));
    expect(sent.map((c) => [c.path, c.body])).toEqual([
      [`/v1/sessions/${session.id}/events`, { events: [{ type: "user.interrupt" }] }],
      [`/v1/sessions/${session.id}/archive`, null],
    ]);
    expect(cronk.managedAgents.session(session.id)).toEqual(expect.objectContaining({ status: "idle", archived: true, deleted: false }));
    expect(cronk.managedAgents.vaults.find((v) => v.id === vaultId)!.deleted).toBe(true);
    expect((await call("GET", `/api/runs/${run.id}`, asAgent)).status).toBe(401);
  });

  test("a lost Run is lost as for any Runner, and its session interrupted and archived", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();

    cronk.clock.advance(31 * 60_000);
    await cronk.checkForLostRuns();

    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("lost");
    expect(cronk.managedAgents.session(session.id)).toEqual(expect.objectContaining({ status: "idle", archived: true }));
  });
});

describe("polling sessions with running Runs", () => {
  test("a session gone idle without finish fails its Run with the stop reason, and is archived", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    const vaultId = (session.body.vault_ids as string[])[0]!;
    cronk.managedAgents.idle(session.id, "retries_exhausted");

    await cronk.pollManagedAgentsSessions();

    const failed = await ok("GET", `/api/runs/${run.id}`, ada);
    expect(failed.state).toBe("failed");
    expect(failed.endReason).toContain("retries_exhausted");
    expect(failed.endReason).toContain("without calling finish");
    expect(cronk.managedAgents.session(session.id).archived).toBe(true);
    expect(cronk.managedAgents.vaults.find((v) => v.id === vaultId)!.deleted).toBe(true);
  });

  test("a session that ended its turn without finish fails its Run too", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    cronk.managedAgents.idle(session.id, "end_turn");

    await cronk.pollManagedAgentsSessions();

    const failed = await ok("GET", `/api/runs/${run.id}`, ada);
    expect(failed.state).toBe("failed");
    expect(failed.endReason).toContain("end_turn");
  });

  test("a terminated session fails its Run, which waits in the Inbox with Retry", async () => {
    const { ada, ticket, startRun, inbox } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);

    await cronk.pollManagedAgentsSessions();

    const failed = await ok("GET", `/api/runs/${run.id}`, ada);
    expect(failed.state).toBe("failed");
    expect(failed.endReason).toContain("terminated");
    expect(JSON.stringify(await inbox())).toContain(ticket.id);
    await ok("POST", `/api/tickets/${ticket.id}/retry`, ada);
    expect((await runsOf(ticket.id, ada)).map((r: { state: string }) => r.state)).toEqual(["failed", "running"]);
  });

  test("a session asking for a confirmation fails its Run with needs a confirmation", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    cronk.managedAgents.idle(session.id, "requires_action");

    await cronk.pollManagedAgentsSessions();

    const failed = await ok("GET", `/api/runs/${run.id}`, ada);
    expect(failed.state).toBe("failed");
    expect(failed.endReason).toMatch(/needs a confirmation/);
  });

  test("a running session leaves its Run running, and an ended Run's session isn't read again", async () => {
    const { ada, ticket, status, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();

    await cronk.pollManagedAgentsSessions();
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Backlog") });
    const reads = () => cronk.managedAgents.calls.filter((c) => c.method === "GET" && c.path === `/v1/sessions/${session.id}`).length;
    const before = reads();
    await cronk.pollManagedAgentsSessions();
    expect(reads()).toBe(before);
  });
});

describe("rate limits", () => {
  test("a 429 pauses the Runner's queue until its retry time: the Ticket waits rather than being refused, and starts once it passes", async () => {
    const { ada, ticket, agent, status } = await adaWithManagedAgentsRunner();
    cronk.managedAgents.rateLimitNext("120");

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect(await runsOf(ticket.id, ada)).toEqual([]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).waiting).not.toBeNull();
    const [paused] = await ok("GET", "/api/runners", ada);
    expect(paused.pausedUntil).toBe(new Date(cronk.clock.now().getTime() + 120_000).toISOString());
    const tokens = await ok("GET", `/api/agents/${agent.id}/tokens`, ada);
    expect(tokens).toEqual([]);

    cronk.clock.advance(120_000);
    await cronk.resumePausedRunners();

    const runs = await runsOf(ticket.id, ada);
    expect(runs.map((r: { state: string }) => r.state)).toEqual(["running"]);
    expect(cronk.managedAgents.sessions).toHaveLength(1);
  });
});

describe("removing the Runner", () => {
  test("stops its running Runs, interrupting and archiving their sessions, and revokes their tokens", async () => {
    const { ada, project, runner, startRun } = await adaWithManagedAgentsRunner();
    const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "And this" });
    const first = await startRun();
    const second = await startRun("Triage", other);
    const tokens = [first, second].map(({ session }) => tokenInVault((session.body.vault_ids as string[])[0]!));

    await ok("DELETE", `/api/runners/${runner.id}`, ada);

    for (const { run, session } of [first, second]) {
      const stopped = await ok("GET", `/api/runs/${run.id}`, ada);
      expect(stopped.state).toBe("stopped");
      expect(stopped.endReason).toContain("Claude API");
      expect(cronk.managedAgents.session(session.id)).toEqual(expect.objectContaining({ status: "idle", archived: true }));
    }
    for (const token of tokens) {
      expect((await call("GET", `/api/runs/${first.run.id}`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    }
    expect(await ok("GET", "/api/runners", ada)).toEqual([]);
  });
});

describe("webhooks", () => {
  /** Ada's Runner with the signing secret of its webhook endpoint saved, as she pastes it from the Console. */
  async function withWebhookSecret() {
    const setup = await adaWithManagedAgentsRunner();
    const secret = cronk.managedAgents.webhookSecret();
    const runner = await ok("PUT", `/api/runners/${setup.runner.id}/webhook-secret`, setup.ada, { secret });
    const deliver = (type: string, sessionId: string, options: { id?: string; secret?: string } = {}) =>
      cronk.managedAgents.deliver(runner.managedAgents.webhookUrl, {
        secret: options.secret ?? secret,
        type,
        sessionId,
        at: cronk.clock.now(),
        id: options.id,
      });
    return { ...setup, runner, secret, deliver };
  }

  test("a signed session.status_idled delivery fails the Run with the stop reason at once, as polling would", async () => {
    const { ada, startRun, deliver } = await withWebhookSecret();
    const { run, session } = await startRun();
    const vaultId = (session.body.vault_ids as string[])[0]!;
    cronk.managedAgents.idle(session.id, "retries_exhausted");

    const answer = await deliver("session.status_idled", session.id);

    expect(answer.status).toBeLessThan(300);
    const failed = await ok("GET", `/api/runs/${run.id}`, ada);
    expect(failed.state).toBe("failed");
    expect(failed.endReason).toContain("retries_exhausted");
    expect(failed.endReason).toContain("without calling finish");
    expect(cronk.managedAgents.session(session.id).archived).toBe(true);
    expect(cronk.managedAgents.vaults.find((v) => v.id === vaultId)!.deleted).toBe(true);
  });

  test("a signed session.status_terminated delivery fails the Run, which waits in the Inbox with Retry", async () => {
    const { ada, ticket, startRun, inbox, deliver } = await withWebhookSecret();
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);

    const answer = await deliver("session.status_terminated", session.id);

    expect(await answer.json()).toEqual({ ended: true });
    const failed = await ok("GET", `/api/runs/${run.id}`, ada);
    expect(failed.state).toBe("failed");
    expect(failed.endReason).toContain("terminated");
    expect(JSON.stringify(await inbox())).toContain(ticket.id);
  });

  test("a delivery with a bad signature is refused and ignored: the Run keeps running", async () => {
    const { ada, runner, startRun, deliver } = await withWebhookSecret();
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);
    const reads = () => cronk.managedAgents.calls.filter((c) => c.path.startsWith(`/v1/sessions/${session.id}`)).length;
    const before = reads();

    const wrongSecret = await deliver("session.status_terminated", session.id, { secret: cronk.managedAgents.webhookSecret() });
    const unsigned = await fetch(runner.managedAgents.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "event", id: "whe_forged", data: { type: "session.status_terminated", id: session.id } }),
    });

    expect(wrongSecret.status).toBe(401);
    expect((await wrongSecret.json()).error.code).toBe("invalid_signature");
    expect(unsigned.status).toBe(401);
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
    expect(reads()).toBe(before);
  });

  test("a delivery signed more than five minutes before Cronk's clock is refused, as a replay", async () => {
    const { ada, runner, secret, startRun } = await withWebhookSecret();
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);

    const stale = await cronk.managedAgents.deliver(runner.managedAgents.webhookUrl, {
      secret,
      type: "session.status_terminated",
      sessionId: session.id,
      at: new Date(cronk.clock.now().getTime() - 6 * 60_000),
    });

    expect(stale.status).toBe(401);
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });

  test("a signed delivery about an unknown session is ignored, as is one about another Runner's Run", async () => {
    const { ada, startRun, deliver } = await withWebhookSecret();
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);
    const unknown = await deliver("session.status_terminated", "sesn_01NOTCRONKS");
    expect(await unknown.json()).toEqual({ ended: false });

    // Another Runner with a key to the same Anthropic workspace, whose endpoint there gets every session's events too.
    const other = await ok("POST", "/api/runners", ada, { name: "Other", kind: "managed_agents", apiKey });
    const secret = cronk.managedAgents.webhookSecret();
    const saved = await ok("PUT", `/api/runners/${other.id}/webhook-secret`, ada, { secret });
    const elsewhere = await cronk.managedAgents.deliver(saved.managedAgents.webhookUrl, {
      secret,
      type: "session.status_terminated",
      sessionId: session.id,
      at: cronk.clock.now(),
    });

    expect(await elsewhere.json()).toEqual({ ended: false });
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });

  test("a delivery whose session is running again by the time Cronk reads it leaves the Run running", async () => {
    const { ada, startRun, deliver } = await withWebhookSecret();
    const { run, session } = await startRun();

    const answer = await deliver("session.status_idled", session.id);

    expect(await answer.json()).toEqual({ ended: false });
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });

  test("other kinds of event are acknowledged and ignored", async () => {
    const { ada, startRun, deliver } = await withWebhookSecret();
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);

    const answer = await deliver("session.status_run_started", session.id);

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ ended: false });
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });

  test("a delivery whose session Anthropic can't read now fails, so Anthropic's retry ends the Run", async () => {
    const { ada, startRun, deliver } = await withWebhookSecret();
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);
    cronk.managedAgents.failNext("GET", `/v1/sessions/${session.id}`, 503);

    const first = await deliver("session.status_terminated", session.id, { id: "whe_01RETRIED" });

    expect(first.status).toBeGreaterThanOrEqual(500);
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");

    const retry = await deliver("session.status_terminated", session.id, { id: "whe_01RETRIED" });

    expect(await retry.json()).toEqual({ ended: true });
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("failed");
  });

  test("a repeated delivery changes nothing, and reads no session", async () => {
    const { ada, ticket, startRun, deliver } = await withWebhookSecret();
    const { run, session } = await startRun();
    cronk.managedAgents.idle(session.id, "end_turn");
    const first = await deliver("session.status_idled", session.id, { id: "whe_01REPEATED" });
    expect(await first.json()).toEqual({ ended: true });
    const after = await ok("GET", `/api/runs/${run.id}`, ada);
    const calls = cronk.managedAgents.calls.length;

    const again = await deliver("session.status_idled", session.id, { id: "whe_01REPEATED" });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ended: false });
    expect(await ok("GET", `/api/runs/${run.id}`, ada)).toEqual(after);
    expect(await runsOf(ticket.id, ada)).toHaveLength(1);
    expect(cronk.managedAgents.calls.length).toBe(calls);
  });

  test("without a saved secret, deliveries are refused and Runs still end by polling", async () => {
    const { ada, runner, startRun } = await adaWithManagedAgentsRunner();
    expect(runner.managedAgents.webhookSecretSaved).toBe(false);
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);

    const refused = await cronk.managedAgents.deliver(runner.managedAgents.webhookUrl, {
      secret: cronk.managedAgents.webhookSecret(),
      type: "session.status_terminated",
      sessionId: session.id,
      at: cronk.clock.now(),
    });
    expect(refused.status).toBe(401);
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");

    await cronk.pollManagedAgentsSessions();

    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("failed");
  });

  test("forgetting the secret refuses deliveries again, leaving Runs to polling", async () => {
    const { ada, runner, startRun, deliver } = await withWebhookSecret();
    const forgotten = await ok("DELETE", `/api/runners/${runner.id}/webhook-secret`, ada);
    expect(forgotten.managedAgents.webhookSecretSaved).toBe(false);
    const { run, session } = await startRun();
    cronk.managedAgents.terminate(session.id);

    expect((await deliver("session.status_terminated", session.id)).status).toBe(401);
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });
});

describe("saving a webhook signing secret", () => {
  test("shows the webhook URL to add in the Console, and keeps the secret, never returning it", async () => {
    const { ada, runner } = await adaWithManagedAgentsRunner();
    expect(runner.managedAgents.webhookUrl).toBe(`${cronk.url}/api/runners/${runner.id}/managed-agents/webhook`);
    const secret = cronk.managedAgents.webhookSecret();

    const saved = await ok("PUT", `/api/runners/${runner.id}/webhook-secret`, ada, { secret: `  ${secret}\n` });

    expect(saved.managedAgents).toEqual(expect.objectContaining({ webhookSecretSaved: true, webhookUrl: runner.managedAgents.webhookUrl }));
    expect(JSON.stringify(saved)).not.toContain(secret.slice(6));
    expect(JSON.stringify(await ok("GET", "/api/runners", ada))).not.toContain(secret.slice(6));
  });

  test("refuses a secret that isn't a whsec_ one, and Runners of other kinds", async () => {
    const { ada, runner } = await adaWithManagedAgentsRunner();
    const subscription = await ok("POST", "/api/runners", ada, { name: "Claude Max", kind: "subscription" });

    const wrong = await call("PUT", `/api/runners/${runner.id}/webhook-secret`, ada, { secret: "sk-ant-api03-not-a-secret" });
    const otherKind = await call("PUT", `/api/runners/${subscription.id}/webhook-secret`, ada, {
      secret: cronk.managedAgents.webhookSecret(),
    });

    expect(wrong.status).toBe(400);
    expect(wrong.json.error.code).toBe("invalid_webhook_secret");
    expect(otherKind.status).toBe(409);
    expect(otherKind.json.error.code).toBe("runner_has_no_webhook");
    expect(subscription.managedAgents).toBeNull();
  });

  test("is only for the Runner's Owner", async () => {
    const { workspace, ada, runner } = await adaWithManagedAgentsRunner();
    const bea = { cookie: (await addMember(cronk, ada.cookie, workspace.id, "bea@example.com")).cookie };

    const refused = await call("PUT", `/api/runners/${runner.id}/webhook-secret`, bea, { secret: cronk.managedAgents.webhookSecret() });
    const notForgotten = await call("DELETE", `/api/runners/${runner.id}/webhook-secret`, bea);

    expect(refused.status).toBe(404);
    expect(notForgotten.status).toBe(404);
  });
});

describe("a Run's Repositories", () => {
  /** The Project lists cronkcorp/cronker and cronkcorp/website, both covered by the GitHub App's installation on cronkcorp. */
  async function withRepositories() {
    const setup = await adaWithManagedAgentsRunner();
    await createGitHubApp(cronk, setup.ada.cookie);
    const installation = cronk.github.install(cronk.github.apps[0]!, "cronkcorp", ["cronker", "website"]);
    for (const repository of installation.repositories) {
      await ok("POST", `/api/projects/${setup.project.id}/repositories`, setup.ada, { id: repository.id });
    }
    return { ...setup, installation };
  }

  /** The installation tokens GitHub issued that are still good, by the test's clock. */
  const goodTokens = () =>
    cronk.github.tokensIssued.filter((t) => t.expiresAt.getTime() > cronk.clock.now().getTime()).map((t) => t.token);

  test("are each mounted on the session as a resource, with an installation token", async () => {
    const { startRun, installation } = await withRepositories();

    const { session } = await startRun();

    const resources = session.body.resources as { type: string; url: string; authorization_token: string }[];
    expect(resources.map(({ type, url }) => ({ type, url }))).toEqual([
      { type: "github_repository", url: `${cronk.github.url}/cronkcorp/cronker` },
      { type: "github_repository", url: `${cronk.github.url}/cronkcorp/website` },
    ]);
    for (const { authorization_token: token } of resources) {
      const issued = cronk.github.tokensIssued.find((t) => t.token === token);
      expect(issued?.installationId).toBe(installation.id);
      expect(goodTokens()).toContain(token);
    }
  });

  test("are none for a Project listing none, which needs no GitHub App", async () => {
    const { startRun } = await adaWithManagedAgentsRunner();

    const { run, session } = await startRun();

    expect(run.state).toBe("running");
    expect(session.body.resources ?? []).toEqual([]);
    expect(cronk.github.apiCalls).toEqual([]);
  });

  test("get fresh installation tokens on the session before theirs expire, while the Run runs", async () => {
    const { startRun } = await withRepositories();
    const { session } = await startRun();
    const tokens = () => cronk.managedAgents.session(session.id).resources.map((r) => r.authorizationToken);
    const first = tokens();

    cronk.clock.advance(minutes(30));
    await cronk.rotateRepositoryTokens();
    expect(tokens()).toEqual(first);

    cronk.clock.advance(minutes(21));
    await cronk.rotateRepositoryTokens();
    const second = tokens();
    expect(second).toHaveLength(2);
    for (const token of second) expect(first).not.toContain(token);

    // The first tokens expire an hour after they were issued; the session's are still good, and keep being renewed.
    cronk.clock.advance(minutes(10));
    for (const token of second) expect(goodTokens()).toContain(token);
    cronk.clock.advance(minutes(40));
    await cronk.rotateRepositoryTokens();
    cronk.clock.advance(minutes(10));
    for (const token of tokens()) expect(goodTokens()).toContain(token);
  });

  test("that the GitHub App no longer covers keep the Run from starting, saying which", async () => {
    const { ada, startRun, installation } = await withRepositories();
    installation.repositories.splice(0, 1);
    // What GitHub said the installation covers is kept for five minutes.
    cronk.clock.advance(minutes(6));

    const { run } = await startRun();

    const refused = await ok("GET", `/api/runs/${run.id}`, ada);
    expect(refused.state).toBe("refused");
    expect(refused.endReason).toContain("cronkcorp/cronker");
    expect(cronk.managedAgents.sessions).toEqual([]);
    expect(cronk.managedAgents.vaults).toEqual([]);
  });

  test("get no fresh tokens once the Run ended", async () => {
    const { ada, ticket, status, startRun } = await withRepositories();
    const { session } = await startRun();
    const first = cronk.managedAgents.session(session.id).resources.map((r) => r.authorizationToken);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Backlog") });

    cronk.clock.advance(minutes(55));
    await cronk.rotateRepositoryTokens();

    expect(cronk.managedAgents.session(session.id).resources.map((r) => r.authorizationToken)).toEqual(first);
    expect(cronk.managedAgents.calls.filter((c) => c.path.includes("/resources/"))).toEqual([]);
  });
});
