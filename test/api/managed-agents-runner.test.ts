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
        managedAgents: { agentId: agent!.id, environmentId: environment!.id },
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

/** What a session's agent does in one turn, as Managed Agents records it: says something, calls a tool of Cronk's, says more. */
const aTurn = [
  { type: "agent.message", processed_at: "2026-01-01T09:00:05.000Z", content: [{ type: "text", text: "Reading the Ticket first." }] },
  {
    id: "sevt_call1",
    type: "agent.mcp_tool_use",
    processed_at: "2026-01-01T09:00:06.000Z",
    mcp_server_name: "cronk",
    name: "read_ticket",
    input: { ticket: "CRONK-1" },
  },
  {
    type: "agent.mcp_tool_result",
    processed_at: "2026-01-01T09:00:07.000Z",
    mcp_tool_use_id: "sevt_call1",
    content: [{ type: "text", text: "CRONK-1 Make it so" }],
  },
  {
    id: "sevt_call2",
    type: "agent.tool_use",
    processed_at: "2026-01-01T09:00:08.000Z",
    name: "bash",
    input: { command: "ls" },
  },
  {
    type: "agent.tool_result",
    processed_at: "2026-01-01T09:00:09.000Z",
    tool_use_id: "sevt_call2",
    content: [{ type: "text", text: "README.md" }],
  },
  { type: "agent.message", processed_at: "2026-01-01T09:00:10.000Z", content: [{ type: "text", text: "It is ready for Implement." }] },
];

/** The Run's Transcript and all its entries, as a User reads them. */
async function transcriptOf(runId: string, as: Request) {
  const run = await ok("GET", `/api/runs/${runId}`, as);
  expect(run.transcriptId, "the Run has a Transcript").not.toBeNull();
  const transcript = await ok("GET", `/api/transcripts/${run.transcriptId}`, as);
  const { entries } = await ok("GET", `/api/transcripts/${run.transcriptId}/entries?limit=1000`, as);
  return { transcript, entries };
}

describe("the Run's Transcript", () => {
  test("an ended Run's Transcript holds its session's events as entries: the Brief, messages and tool calls with their results", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    cronk.managedAgents.emit(session.id, ...aTurn);
    const asAgent = { headers: { authorization: `Bearer ${tokenInVault((session.body.vault_ids as string[])[0]!)}` } };

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    const { transcript, entries } = await transcriptOf(run.id, ada);
    expect(transcript).toMatchObject({ runId: run.id, sessionId: session.id, agent: { name: "claude-api" }, gap: null });
    const brief = (session.body.initial_events as { content: { text: string }[] }[])[0]!.content[0]!.text;
    expect(entries).toEqual([
      expect.objectContaining({ position: 1, role: "user", text: brief, toolName: null }),
      { position: 2, role: "assistant", text: "Reading the Ticket first.", toolName: null, toolInput: null, toolResult: null, cut: false, at: "2026-01-01T09:00:05.000Z" },
      {
        position: 3,
        role: "assistant",
        text: null,
        toolName: "mcp__cronk__read_ticket",
        toolInput: { ticket: "CRONK-1" },
        toolResult: "CRONK-1 Make it so",
        cut: false,
        at: "2026-01-01T09:00:06.000Z",
      },
      expect.objectContaining({ position: 4, toolName: "bash", toolInput: { command: "ls" }, toolResult: "README.md" }),
      expect.objectContaining({ position: 5, role: "assistant", text: "It is ready for Implement." }),
      // Its session was still running when the agent called finish, so Cronk interrupted it before archiving it.
      expect.objectContaining({ position: 6, role: "system", text: "The session was interrupted." }),
    ]);
  });

  test("is scrubbed and its long tool results cut, as any Transcript, when a terminated session ends the Run", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    // Made up, of GitHub's shape, put together here so the source holds none whole.
    const secret = "ghp_" + "16C7e42F292c6912E7710c838347Ae178B4a";
    cronk.managedAgents.emit(
      session.id,
      { type: "agent.message", content: [{ type: "text", text: `Pushing with ${secret} now.` }] },
      { id: "sevt_read", type: "agent.tool_use", name: "read", input: { path: "big.log", token: secret } },
      { type: "agent.tool_result", tool_use_id: "sevt_read", content: [{ type: "text", text: "a".repeat(20 * 1024) + "b".repeat(100) }] },
    );
    cronk.managedAgents.terminate(session.id);

    await cronk.pollManagedAgentsSessions();

    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("failed");
    const { entries } = await transcriptOf(run.id, ada);
    expect(entries.slice(1)).toEqual([
      expect.objectContaining({ text: "Pushing with [scrubbed] now." }),
      expect.objectContaining({ toolName: "read", toolInput: { path: "big.log", token: "[scrubbed]" }, toolResult: "a".repeat(20 * 1024), cut: true }),
    ]);
  });

  test("a running Run's Transcript, opened, fetches the events its session added since the last fetch", async () => {
    const { ada, startRun } = await adaWithManagedAgentsRunner();
    const { run, session } = await startRun();
    const { transcriptId } = await ok("GET", `/api/runs/${run.id}`, ada);
    const eventReads = () => cronk.managedAgents.calls.filter((c) => c.method === "GET" && c.path === `/v1/sessions/${session.id}/events`);
    // The call is made, its result not back yet.
    cronk.managedAgents.emit(session.id, ...aTurn.slice(0, 2));

    const opened = await ok("GET", `/api/transcripts/${transcriptId}`, ada);

    expect(opened.entryCount).toBe(3);
    const { entries: first } = await ok("GET", `/api/transcripts/${transcriptId}/entries`, ada);
    expect(first.map((e: { text: string; toolName: string }) => e.text ?? e.toolName).slice(1)).toEqual([
      "Reading the Ticket first.",
      "mcp__cronk__read_ticket",
    ]);
    expect(first[2].toolResult).toBeNull();

    cronk.managedAgents.emit(session.id, ...aTurn.slice(2));
    const readsBefore = eventReads().length;
    const reopened = await ok("GET", `/api/transcripts/${transcriptId}`, ada);

    expect(eventReads().length).toBe(readsBefore + 1);
    expect(reopened.entryCount).toBe(5);
    const { entries } = await ok("GET", `/api/transcripts/${transcriptId}/entries`, ada);
    expect(entries.slice(1).map((e: { text: string; toolName: string; toolResult: string }) => [e.text ?? e.toolName, e.toolResult])).toEqual([
      ["Reading the Ticket first.", null],
      ["mcp__cronk__read_ticket", "CRONK-1 Make it so"],
      ["bash", "README.md"],
      ["It is ready for Implement.", null],
    ]);
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
  });
});

