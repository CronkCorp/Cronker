import type { Context } from "../context.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { mcpResource } from "../oauth/authorizations.js";
import { transaction } from "../db.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import type { Runner, RunnerRefusal, RunReports, RunToStart, StartResult } from "./runner.js";
import { retryAt } from "./subscription.js";

/**
 * The Managed Agents Runner: sessions of an agent Cronk defines in the Owner's own Anthropic workspace, spending their
 * Claude API credits. Setting it up with an API key creates one agent definition (Cronk's MCP server, tools allowed
 * without asking) and one cloud environment.
 */

/** The beta the Managed Agents endpoints ship under. */
const beta = "managed-agents-2026-04-01";
/** The name Cronk's MCP server goes by on the agent. */
const mcpServerName = "cronk";

/** An answer from the Managed Agents API. */
interface Answer {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
}

/** Calls the Managed Agents API with the API key; throws only when it can't be reached. */
async function anthropic(context: Context, apiKey: string, method: string, path: string, body?: unknown): Promise<Answer> {
  const response = await fetch(new URL(path, context.config.managedAgentsApiUrl), {
    method,
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": beta,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: parsed, headers: response.headers };
}

/** What Anthropic said went wrong, for a refusal's message. */
function errorOf(answer: Answer): string {
  const message = (answer.body.error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" && message ? `${answer.status}: ${message}` : String(answer.status);
}

/** What a `managed_agents` Runner keeps from its setting up. */
export interface ManagedAgentsSetup {
  apiKeySealed: string;
  agentId: string;
  environmentId: string;
}

/**
 * Creates the agent definition and the cloud environment for a new `managed_agents` Runner with the Owner's API key,
 * refusing at once with `api_key_rejected` when Anthropic rejects the key. The key comes back sealed.
 */
export async function setUpManagedAgents(context: Context, input: { name: string; apiKey: string }): Promise<ManagedAgentsSetup> {
  const apiKey = input.apiKey.trim();
  const apiKeySealed = requireSecretBox(context.config).seal(apiKey);
  const create = async (path: string, body: unknown, what: string): Promise<string> => {
    let answer: Answer;
    try {
      answer = await anthropic(context, apiKey, "POST", path, body);
    } catch (error) {
      throw new ApiError(502, "anthropic_unreachable", `Cronk couldn't reach Anthropic to create ${what}: ${(error as Error).message}.`);
    }
    if (answer.status === 401 || answer.status === 403) {
      throw new ApiError(400, "api_key_rejected", `Anthropic rejected the API key (${errorOf(answer)}): check it, or make a new one in the Claude Console.`);
    }
    if (answer.status < 200 || answer.status >= 300 || typeof answer.body.id !== "string") {
      throw new ApiError(502, "anthropic_refused", `Anthropic answered ${errorOf(answer)} when Cronk created ${what}.`);
    }
    return answer.body.id;
  };
  const name = `Cronk: ${input.name.trim()}`;
  const allowed = { type: "always_allow" };
  const agentId = await create(
    "v1/agents",
    {
      name,
      description: `Runs of Cronk at ${context.config.publicUrl.origin}; each session's first message is its Brief.`,
      model: defaultModel,
      mcp_servers: [{ type: "url", name: mcpServerName, url: mcpResource(context) }],
      // An unattended Run can't answer a confirmation, so its default tools and Cronk's run without asking.
      tools: [
        { type: "agent_toolset_20260401", default_config: { enabled: true, permission_policy: allowed } },
        { type: "mcp_toolset", mcp_server_name: mcpServerName, default_config: { permission_policy: allowed } },
      ],
    },
    "the agent",
  );
  let environmentId: string;
  try {
    environmentId = await create(
      "v1/environments",
      { name, config: { type: "cloud", networking: { type: "unrestricted" } } },
      "the cloud environment",
    );
  } catch (error) {
    // No Runner is set up, so its agent would be left over in the Owner's workspace: agents are archived, not deleted.
    await anthropic(context, apiKey, "POST", `v1/agents/${encodeURIComponent(agentId)}/archive`).catch(() => {});
    throw error;
  }
  return { apiKeySealed, agentId, environmentId };
}

/** The model the agent definition names; every session overrides it with its Step's. */
const defaultModel = "claude-sonnet-5-5";

/** The model each Step's label stands for; a label that is a model id already, such as `claude-opus-4-8`, is sent as it is. */
const modelOfLabel: Record<string, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-2",
};
const modelFor = (label: string) => modelOfLabel[label.trim().toLowerCase()] ?? label.trim();

/** Where a session is followed in the Claude Console. */
const consoleUrl = (sessionId: string) => `https://platform.claude.com/workspaces/default/sessions/${encodeURIComponent(sessionId)}`;

/** The Runner a Run starts through, as its Owner set it up. */
interface StoredRunner {
  apiKeySealed: string | null;
  agentId: string | null;
  environmentId: string | null;
}

/**
 * What a Managed Agents Run holds in Cronk and in Anthropic, and which of it was let go once the Run ended: its token
 * revoked, its vault deleted, its session archived.
 */
interface HeldRun {
  runId: string;
  apiKeySealed: string;
  tokenId: string | null;
  vaultId: string | null;
  sessionId: string | null;
  revoked: boolean;
  vaultDeleted: boolean;
  archived: boolean;
}

const heldColumns = `run_id as "runId", api_key_sealed as "apiKeySealed", token_id as "tokenId", vault_id as "vaultId",
  session_id as "sessionId", revoked_at is not null as revoked, vault_deleted_at is not null as "vaultDeleted",
  archived_at is not null as archived`;

/** The `managed_agents` Runner. */
export function managedAgentsRunner(context: Context): Runner {
  const { db, clock } = context;

  /** Mints a fresh full token of the Run's Agent, recorded against the Run so it is revoked when the Run ends. */
  async function mintToken(run: RunToStart, apiKeySealed: string): Promise<string> {
    const secret = issueSecret("agent");
    await transaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into agent_tokens (agent_id, name, access, token_hash, created_at) values ($1, $2, 'full', $3, $4) returning id`,
        [run.agent.id, `Run on ${run.ticket.key}`, hashSecret(secret), clock.now()],
      );
      await tx.query("insert into managed_agent_runs (run_id, api_key_sealed, token_id) values ($1, $2, $3)", [
        run.runId,
        apiKeySealed,
        rows[0]!.id,
      ]);
    });
    return secret;
  }

  async function start(run: RunToStart, apiKey: string, stored: StoredRunner & { agentId: string; environmentId: string }) {
    const refuse = (refusal: RunnerRefusal): StartResult => ({ started: false, refusal });
    const token = await mintToken(run, stored.apiKeySealed!);
    /** Refuses the Run as Anthropic's answer says; what it holds so far is let go of once Cronk records the refusal. */
    const refuseFor = (answer: Answer | Error, what: string): StartResult => {
      const named = `${what} for ${run.ticket.key} on ${run.runner.name}`;
      if (answer instanceof Error) {
        return refuse({ kind: "unavailable", message: `Cronk couldn't reach Anthropic to create ${named}: ${answer.message}.` });
      }
      if (answer.status === 429) {
        const until = retryAt(clock.now(), answer.headers.get("retry-after"));
        return refuse({ kind: "rate_limited", message: `Anthropic rate limited ${named}.`, retryAt: until });
      }
      if (answer.status === 401 || answer.status === 403) {
        return refuse({
          kind: "credentials_rejected",
          message: `Anthropic rejected the API key of ${run.runner.name} (${errorOf(answer)}): its Owner sets the Runner up again with a new key.`,
        });
      }
      return refuse({ kind: "unavailable", message: `Anthropic answered ${errorOf(answer)} when Cronk created ${named}.` });
    };
    /** Creates something in Anthropic, recording its id on the Run at once, so it is let go of whatever happens next. */
    const create = async (what: string, path: string, body: unknown, record?: string): Promise<string | StartResult> => {
      let answer: Answer;
      try {
        answer = await anthropic(context, apiKey, "POST", path, body);
      } catch (error) {
        return refuseFor(error as Error, what);
      }
      if (answer.status < 200 || answer.status >= 300 || typeof answer.body.id !== "string") return refuseFor(answer, what);
      if (record) await db.query(`update managed_agent_runs set ${record} where run_id = $1`, [run.runId, answer.body.id]);
      return answer.body.id;
    };

    // A vault of the Run's own: a vault holds one credential per MCP server URL, so Runs at once can't share one.
    const vaultId = await create(
      "the vault",
      "v1/vaults",
      { display_name: `Cronk Run on ${run.ticket.key}`, metadata: { cronk_run_id: run.runId } },
      "vault_id = $2, vault_deleted_at = null",
    );
    if (typeof vaultId !== "string") return vaultId;
    const credentialId = await create("the vault credential", `v1/vaults/${encodeURIComponent(vaultId)}/credentials`, {
      display_name: "Cronk",
      auth: { type: "static_bearer", mcp_server_url: mcpResource(context), token },
    });
    if (typeof credentialId !== "string") return credentialId;
    const sessionId = await create(
      "the session",
      "v1/sessions",
      {
        agent: { type: "agent_with_overrides", id: stored.agentId, model: { id: modelFor(run.model) } },
        environment_id: stored.environmentId,
        vault_ids: [vaultId],
        title: `${run.ticket.key} in ${run.project.name}`,
        metadata: { cronk_run_id: run.runId },
        initial_events: [{ type: "user.message", content: [{ type: "text", text: run.brief }] }],
      },
      "session_id = $2, archived_at = null",
    );
    if (typeof sessionId !== "string") return sessionId;
    return { started: true, reference: { sessionId, url: consoleUrl(sessionId) } } satisfies StartResult;
  }

  return {
    async start(run): Promise<StartResult> {
      const { rows } = await db.query<StoredRunner>(
        `select api_key_sealed as "apiKeySealed", managed_agent_id as "agentId", managed_environment_id as "environmentId"
         from runners where id = $1`,
        [run.runner.id],
      );
      const stored = rows[0];
      if (!stored?.apiKeySealed || !stored.agentId || !stored.environmentId) {
        return {
          started: false,
          refusal: { kind: "not_configured", message: `${run.runner.name} has no API key: its Owner sets the Runner up again.` },
        };
      }
      let apiKey: string;
      try {
        apiKey = requireSecretBox(context.config).open(stored.apiKeySealed);
      } catch {
        return {
          started: false,
          refusal: {
            kind: "not_configured",
            message:
              `Cronk can't read the API key of ${run.runner.name}, as CRONK_SECRET_KEY changed or is unset: ` +
              "its Owner sets the Runner up again.",
          },
        };
      }
      let result: StartResult;
      try {
        result = await start(run, apiKey, { ...stored, agentId: stored.agentId, environmentId: stored.environmentId });
      } catch (error) {
        // Cronk records the Run as couldn't start: what it holds so far is let go of, as for a refusal.
        await letGo(context, run.runId).catch(() => {});
        throw error;
      }
      // A refused Run lets go of what it holds so far. So does one that ended while it started, as when a User moved
      // its Ticket meanwhile, since stopping it found no session yet. The next poll tries again for anything Anthropic
      // didn't take.
      const { rows: still } = await db.query<{ running: boolean }>("select state = 'running' as running from runs where id = $1", [
        run.runId,
      ]);
      if (!result.started || !still[0]?.running) await letGo(context, run.runId).catch(() => {});
      return result;
    },
    async stop(run) {
      await letGo(context, run.runId);
    },
    async ended(run) {
      await letGo(context, run.runId);
    },
    stopsRunsWhenRemoved: true,
  };
}

/**
 * Lets go of what an ended Run holds, each step at most once and recorded as it succeeds: revokes its token (the
 * guard that counts), deletes its vault, and interrupts its session if it is still running, archiving it once idle.
 * A session is archived, never deleted, so its Console link keeps working. Whatever Anthropic didn't take now, such
 * as a session still busy after its interrupt, the next poll tries again.
 */
async function letGo(context: Context, runId: string): Promise<void> {
  const { db, clock } = context;
  const { rows } = await db.query<HeldRun>(`select ${heldColumns} from managed_agent_runs where run_id = $1`, [runId]);
  const held = rows[0];
  if (!held) return;
  const mark = (column: string) =>
    db.query(`update managed_agent_runs set ${column} = $2 where run_id = $1 and ${column} is null`, [runId, clock.now()]);
  if (!held.revoked) {
    if (held.tokenId) await db.query("delete from agent_tokens where id = $1", [held.tokenId]);
    await mark("revoked_at");
  }
  const apiKey = requireSecretBox(context.config).open(held.apiKeySealed);
  const call = (method: string, path: string, body?: unknown) => anthropic(context, apiKey, method, path, body);
  if (!held.vaultDeleted) {
    const deleted = held.vaultId ? (await call("DELETE", `v1/vaults/${encodeURIComponent(held.vaultId)}`)).status : 200;
    if ((deleted >= 200 && deleted < 300) || deleted === 404) await mark("vault_deleted_at");
  }
  if (!held.archived) {
    if (!held.sessionId) return void (await mark("archived_at"));
    const path = `v1/sessions/${encodeURIComponent(held.sessionId)}`;
    let session = await call("GET", path);
    if (session.status === 404) return void (await mark("archived_at"));
    if (session.body.status === "running" || session.body.status === "rescheduling") {
      await call("POST", `${path}/events`, { events: [{ type: "user.interrupt" }] });
      session = await call("GET", path);
    }
    // A running session can't be archived; an interrupt makes it idle, and the next poll archives it if it isn't yet.
    if (session.status !== 200 || session.body.status === "running" || session.body.status === "rescheduling") return;
    if (session.body.archived_at || (await call("POST", `${path}/archive`)).status === 200) await mark("archived_at");
  }
}

/**
 * Reads the session of each running Managed Agents Run, ending the Runs whose sessions stopped without their Agent
 * calling `finish`: one that went idle fails with its stop reason, one asking for a confirmation fails with *needs a
 * confirmation*, and a terminated one fails. Reporting the end archives the session and revokes the Run's token. Then
 * lets go of what ended Runs still hold, where letting go failed before. A session Cronk can't read now is read again
 * next time. The server runs this every few minutes; webhooks, when set up, only make it sooner.
 */
export async function pollManagedAgentsSessions(context: Context, reports: RunReports): Promise<void> {
  const { rows } = await context.db.query<{ runId: string; sessionId: string; apiKeySealed: string }>(
    `select m.run_id as "runId", m.session_id as "sessionId", m.api_key_sealed as "apiKeySealed"
     from managed_agent_runs m join runs on runs.id = m.run_id
     where runs.state = 'running' and m.session_id is not null`,
  );
  // One Run's failure doesn't hold up the others; the first is thrown at the end for the server to log.
  const failures: unknown[] = [];
  for (const { runId, sessionId, apiKeySealed } of rows) {
    try {
      const why = await whySessionStopped(context, requireSecretBox(context.config).open(apiKeySealed), sessionId);
      if (why) await reports.endedWithoutFinishing(runId, why);
    } catch (error) {
      failures.push(error);
    }
  }
  // A Run whose refused start was unrecorded, as for a rate limit, has no row in `runs` left.
  const { rows: unfinished } = await context.db.query<{ runId: string }>(
    `select m.run_id as "runId" from managed_agent_runs m left join runs on runs.id = m.run_id
     where (m.revoked_at is null or m.vault_deleted_at is null or m.archived_at is null)
       and runs.state is distinct from 'running'`,
  );
  for (const { runId } of unfinished) await letGo(context, runId).catch((error: unknown) => failures.push(error));
  if (failures.length > 0) throw failures[0];
}
/** Why the session stopped without its Agent calling `finish`, or nothing while it is still at work. */
async function whySessionStopped(context: Context, apiKey: string, sessionId: string): Promise<string | null> {
  const path = `v1/sessions/${encodeURIComponent(sessionId)}`;
  const session = await anthropic(context, apiKey, "GET", path);
  if (session.status === 404) return "Its session is gone from Anthropic, without the agent calling finish.";
  if (session.status !== 200) return null;
  if (session.body.status === "terminated") return "Its session terminated without the agent calling finish.";
  if (session.body.status !== "idle") return null;
  // The session carries no stop reason: its latest idle event does.
  const events = await anthropic(context, apiKey, "GET", `${path}/events?order=desc&limit=100`);
  const idle = ((events.body.data ?? []) as { type?: string; stop_reason?: { type?: string } }[]).find(
    (event) => event.type === "session.status_idle",
  );
  const stopReason = idle?.stop_reason?.type;
  if (!stopReason) return null;
  if (stopReason === "requires_action") {
    return "Its session needs a confirmation, which Cronk can't give: the session asked to confirm a tool call.";
  }
  return `Its session went idle without calling finish (stop reason: ${stopReason}).`;
}
