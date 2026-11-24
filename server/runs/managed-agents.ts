import { createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "../context.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { mcpResource } from "../oauth/authorizations.js";
import { transaction } from "../db.js";
import { freshTokens, repositoryUrl, tokenRotationMarginMs, withFreshTokens, type RepositoryWithToken } from "../github/repository-tokens.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import type { Cost } from "./costs.js";
import { convertManagedAgentsEvents } from "../transcripts/managed-agents.js";
import { appendTranscript } from "../transcripts/transcripts.js";
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

/** Something Cronk created in Anthropic: its id and what Anthropic answered. */
interface Created {
  id: string;
  body: Record<string, unknown>;
}

type RepositoryToMount = RepositoryWithToken;

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
  /** Its budget per Run in US cents, or null for none. */
  budgetPerRun: number | null;
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
  transcriptFetched: boolean;
}

const heldColumns = `run_id as "runId", api_key_sealed as "apiKeySealed", token_id as "tokenId", vault_id as "vaultId",
  session_id as "sessionId", revoked_at is not null as revoked, vault_deleted_at is not null as "vaultDeleted",
  archived_at is not null as archived, transcript_fetched_at is not null as "transcriptFetched"`;

/** The `managed_agents` Runner, reporting its Runs' costs to `reports`. */
export function managedAgentsRunner(context: Context, reports: RunReports): Runner {
  const { db, clock } = context;

  /** Mints a fresh Write token of the Run's Agent, recorded against the Run so it is revoked when the Run ends. */
  async function mintToken(run: RunToStart, apiKeySealed: string): Promise<string> {
    const secret = issueSecret("agent");
    await transaction(db, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into agent_tokens (agent_id, name, access, token_hash, created_at) values ($1, $2, 'write', $3, $4) returning id`,
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
    let repositories: RepositoryToMount[];
    try {
      repositories = await withFreshTokens(context, run.repositories);
    } catch (error) {
      return refuse({
        kind: "unavailable",
        message: `Cronk couldn't get GitHub tokens for the Repositories of ${run.project.name}. ${(error as Error).message}`,
      });
    }
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
    const create = async (what: string, path: string, body: unknown, record?: string): Promise<Created | StartResult> => {
      let answer: Answer;
      try {
        answer = await anthropic(context, apiKey, "POST", path, body);
      } catch (error) {
        return refuseFor(error as Error, what);
      }
      if (answer.status < 200 || answer.status >= 300 || typeof answer.body.id !== "string") return refuseFor(answer, what);
      if (record) await db.query(`update managed_agent_runs set ${record} where run_id = $1`, [run.runId, answer.body.id]);
      return { id: answer.body.id, body: answer.body };
    };

    // A vault of the Run's own: a vault holds one credential per MCP server URL, so Runs at once can't share one.
    const vault = await create(
      "the vault",
      "v1/vaults",
      { display_name: `Cronk Run on ${run.ticket.key}`, metadata: { cronk_run_id: run.runId } },
      "vault_id = $2, vault_deleted_at = null",
    );
    if ("started" in vault) return vault;
    const vaultId = vault.id;
    const credential = await create("the vault credential", `v1/vaults/${encodeURIComponent(vaultId)}/credentials`, {
      display_name: "Cronk",
      auth: { type: "static_bearer", mcp_server_url: mcpResource(context), token },
    });
    if ("started" in credential) return credential;
    const session = await create(
      "the session",
      "v1/sessions",
      {
        agent: { type: "agent_with_overrides", id: stored.agentId, model: { id: modelFor(run.model) } },
        environment_id: stored.environmentId,
        vault_ids: [vaultId],
        resources: repositories.map((r) => ({
          type: "github_repository",
          url: repositoryUrl(context, r.fullName),
          authorization_token: r.token,
        })),
        title: `${run.ticket.key} in ${run.project.name}`,
        metadata: { cronk_run_id: run.runId },
        ...(stored.budgetPerRun === null
          ? {}
          : { budget: { type: "limit", max_list_cost: { amount: String(stored.budgetPerRun), currency: "USD" } } }),
        initial_events: [{ type: "user.message", content: [{ type: "text", text: run.brief }] }],
      },
      "session_id = $2, archived_at = null",
    );
    if ("started" in session) return session;
    const sessionId = session.id;
    // Anthropic answers with the session's resources, each with the id a fresh token is set by: found by its URL, or
    // else by its place, as Anthropic lists them in the order they were given.
    const resources = Array.isArray(session.body.resources) ? (session.body.resources as { id?: unknown; url?: unknown }[]) : [];
    for (const [index, repository] of repositories.entries()) {
      const url = repositoryUrl(context, repository.fullName);
      const resourceId = (resources.find((r) => r.url === url) ?? resources[index])?.id;
      if (typeof resourceId !== "string") continue;
      await db.query(
        `insert into managed_agent_run_resources (run_id, resource_id, repository_id, token_expires_at) values ($1, $2, $3, $4)
         on conflict do nothing`,
        [run.runId, resourceId, repository.id, repository.expiresAt],
      );
    }
    // The Run's Transcript is there from its start, for its Ticket to link while it runs; opening it fetches its events.
    await transaction(db, async (tx) => {
      const { rows } = await tx.query<{ workspaceId: string }>(`select workspace_id as "workspaceId" from runs where id = $1`, [
        run.runId,
      ]);
      if (!rows[0]) return;
      const runSession = { workspaceId: rows[0].workspaceId, agentId: run.agent.id, runId: run.runId, sessionId };
      await appendTranscript(context, tx, runSession, { entries: [], results: [] });
    });
    return { started: true, reference: { sessionId, url: consoleUrl(sessionId) } } satisfies StartResult;
  }

  return {
    // A Managed Agents session runs in Anthropic's cloud environment.
    cloud: true,
    async start(run): Promise<StartResult> {
      const { rows } = await db.query<StoredRunner>(
        `select api_key_sealed as "apiKeySealed", managed_agent_id as "agentId", managed_environment_id as "environmentId",
           budget_per_run as "budgetPerRun"
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
        await letGo(context, reports, run.runId).catch(() => {});
        throw error;
      }
      // A refused Run lets go of what it holds so far. So does one that ended while it started, as when a User moved
      // its Ticket meanwhile, since stopping it found no session yet. The next poll tries again for anything Anthropic
      // didn't take.
      const { rows: still } = await db.query<{ running: boolean }>("select state = 'running' as running from runs where id = $1", [
        run.runId,
      ]);
      if (!result.started || !still[0]?.running) await letGo(context, reports, run.runId).catch(() => {});
      return result;
    },
    async stop(run) {
      await letGo(context, reports, run.runId);
    },
    async ended(run) {
      await letGo(context, reports, run.runId);
    },
    async followTranscript(run) {
      await fetchEvents(context, run.runId);
    },
    stopsRunsWhenRemoved: true,
  };
}

/**
 * A cost as Anthropic writes one, such as a session's `usage.list_cost` or its budget's `max_list_cost`: an integer
 * string of minor units with its currency. Nothing if it isn't one.
 */
function parseCost(written: unknown): Cost | null {
  const { amount, currency } = (written ?? {}) as { amount?: unknown; currency?: unknown };
  if (typeof amount !== "string" || !/^\d{1,15}$/.test(amount) || typeof currency !== "string") return null;
  return { amount: Number(amount), currency };
}

/** What a session cost so far at list prices, as its `usage.list_cost` reports it; nothing if it reports none. */
const costOf = (session: Record<string, unknown>): Cost | null =>
  parseCost((session.usage as { list_cost?: unknown } | undefined)?.list_cost);

/** A cost as a person reads it, such as `$5.00`, or `500 EUR` (minor units) for a currency other than US dollars. */
const shownCost = ({ amount, currency }: Cost) => (currency === "USD" ? `$${(amount / 100).toFixed(2)}` : `${amount} ${currency} (minor units)`);

/**
 * Lets go of what an ended Run holds, each step at most once and recorded as it succeeds: revokes its token (the
 * guard that counts), deletes its vault, and interrupts its session if it is still running, archiving it once idle.
 * A session is archived, never deleted, so its Console link keeps working. Once the session no longer runs, what it
 * cost is reported for the Run. Whatever Anthropic didn't take now, such as a session still busy after its
 * interrupt, the next poll tries again.
 */
async function letGo(context: Context, reports: RunReports, runId: string): Promise<void> {
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
    if (!held.sessionId) await mark("archived_at");
    else if (!(await archive(held.sessionId))) return;
  }
  // Once the session is archived its events are all there is: the last of them go into the Run's Transcript.
  if (!held.transcriptFetched) {
    await fetchEvents(context, runId);
    await mark("transcript_fetched_at");
  }

  /** Archives the session once idle, saying whether it is archived (or gone) now. */
  async function archive(sessionId: string): Promise<boolean> {
    const path = `v1/sessions/${encodeURIComponent(sessionId)}`;
    let session = await call("GET", path);
    if (session.status === 404) {
      await mark("archived_at");
      return true;
    }
    if (session.body.status === "running" || session.body.status === "rescheduling") {
      await call("POST", `${path}/events`, { events: [{ type: "user.interrupt" }] });
      session = await call("GET", path);
    }
    // A running session can't be archived; an interrupt makes it idle, and the next poll archives it if it isn't yet.
    if (session.status !== 200 || session.body.status === "running" || session.body.status === "rescheduling") return false;
    // A session that no longer runs spends nothing more, so what it reports now is what the Run cost.
    const cost = costOf(session.body);
    if (cost) await reports.cost(runId, cost);
    if (!session.body.archived_at && (await call("POST", `${path}/archive`)).status !== 200) return false;
    await mark("archived_at");
    return true;
  }
}

/** How many events Cronk asks for a page. */
const eventsPageSize = 1000;

/**
 * Appends what the Run's session recorded since the last fetch to its Transcript: reads its events page by page from
 * the page where the last fetch stopped, until none are left, and converts those it hadn't taken. A fetch that another
 * finished first meanwhile is dropped, as that one took the same events. Throws when Anthropic doesn't answer, leaving
 * the Transcript as it was; a session gone from Anthropic has nothing more to add.
 */
async function fetchEvents(context: Context, runId: string): Promise<void> {
  const { rows } = await context.db.query<{
    apiKeySealed: string;
    sessionId: string | null;
    eventsPage: string | null;
    eventsTaken: number;
    workspaceId: string;
    agentId: string;
  }>(
    `select m.api_key_sealed as "apiKeySealed", m.session_id as "sessionId", m.events_page as "eventsPage",
       m.events_taken as "eventsTaken", runs.workspace_id as "workspaceId", runs.agent_id as "agentId"
     from managed_agent_runs m join runs on runs.id = m.run_id where m.run_id = $1`,
    [runId],
  );
  const held = rows[0];
  if (!held?.sessionId) return;
  const apiKey = requireSecretBox(context.config).open(held.apiKeySealed);
  const path = `v1/sessions/${encodeURIComponent(held.sessionId)}/events`;
  const events: unknown[] = [];
  let page = held.eventsPage;
  let skip = held.eventsTaken;
  let stoppedAt = { page: held.eventsPage, taken: held.eventsTaken };
  for (;;) {
    const query = new URLSearchParams({ limit: String(eventsPageSize), ...(page === null ? {} : { page }) });
    const answer = await anthropic(context, apiKey, "GET", `${path}?${query}`);
    if (answer.status === 404) return;
    if (answer.status !== 200) throw new Error(`Anthropic answered ${errorOf(answer)} when Cronk fetched the events of ${held.sessionId}.`);
    const data = Array.isArray(answer.body.data) ? (answer.body.data as unknown[]) : [];
    events.push(...data.slice(skip));
    if (data.length > skip) stoppedAt = { page, taken: data.length };
    skip = 0;
    const next = answer.body.next_page;
    if (typeof next !== "string" || !next) break;
    page = next;
  }
  if (events.length === 0) return;
  await transaction(context.db, async (tx) => {
    const { rowCount } = await tx.query(
      `update managed_agent_runs set events_page = $2, events_taken = $3
       where run_id = $1 and events_page is not distinct from $4 and events_taken = $5`,
      [runId, stoppedAt.page, stoppedAt.taken, held.eventsPage, held.eventsTaken],
    );
    if (!rowCount) return;
    const session = { workspaceId: held.workspaceId, agentId: held.agentId, runId, sessionId: held.sessionId! };
    await appendTranscript(context, tx, session, convertManagedAgentsEvents(events));
  });
}

/** Where Anthropic sends a `managed_agents` Runner's webhook deliveries; one per Runner, as each has its own secret. */
export const managedAgentsWebhookPath = "/api/runners/:runnerId/managed-agents/webhook";

/** The webhook endpoint URL a Runner's Owner adds in the Anthropic Console. */
export const managedAgentsWebhookUrl = (context: Context, runnerId: string): string =>
  new URL(managedAgentsWebhookPath.replace(":runnerId", encodeURIComponent(runnerId)), context.config.publicUrl).toString();

/** The session events that may end a Run; any other delivery is acknowledged and ignored. */
const endingEvents = new Set(["session.status_idled", "session.status_terminated"]);

/** How far a delivery's `webhook-timestamp` may be from Cronk's clock, as Anthropic's SDKs allow, against replays. */
const deliveryTolerance = 5 * 60_000;

const invalidSignature = () =>
  new ApiError(401, "invalid_signature", "The delivery isn't signed with this Runner's webhook signing secret.");

/** The Standard Webhooks headers Anthropic signs a delivery with. */
export interface WebhookHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/**
 * Whether a delivery is signed with the secret, as Standard Webhooks says: one of the space-separated `v1,` signatures
 * is the base64 HMAC-SHA256, keyed with the secret's base64 after `whsec_`, of `id.timestamp.body`, and the timestamp
 * is within five minutes of Cronk's clock.
 */
function isSigned(context: Context, secret: string, body: Buffer, headers: WebhookHeaders): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(context.clock.now().getTime() - Number(timestamp) * 1000) > deliveryTolerance) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.`).update(body).digest();
  return signature.split(" ").some((given) => {
    if (!given.startsWith("v1,")) return false;
    const decoded = Buffer.from(given.slice(3), "base64");
    return decoded.length === expected.length && timingSafeEqual(decoded, expected);
  });
}

/**
 * Takes a webhook delivery to a `managed_agents` Runner's endpoint. One not signed with the Runner's saved secret, or
 * to a Runner with none, is refused with `invalid_signature` before anything else is looked at. A signed
 * `session.status_idled` or `session.status_terminated` about the session of one of the Runner's running Runs reads
 * that session and ends the Run as polling would; anything else, such as a session of no running Run of this Runner or
 * a delivery repeated after its Run ended, changes nothing. Returns whether this delivery ended a Run.
 */
export async function receiveManagedAgentsDelivery(
  context: Context,
  reports: RunReports,
  runnerId: string,
  body: Buffer,
  headers: WebhookHeaders,
): Promise<boolean> {
  const { rows: runners } = isUuid(runnerId)
    ? await context.db.query<{ secretSealed: string }>(
        `select webhook_secret_sealed as "secretSealed" from runners
         where id = $1 and kind = 'managed_agents' and webhook_secret_sealed is not null`,
        [runnerId],
      )
    : { rows: [] };
  if (!runners[0]) throw invalidSignature();
  let secret: string;
  try {
    secret = requireSecretBox(context.config).open(runners[0].secretSealed);
  } catch {
    // CRONK_SECRET_KEY changed or is unset, so no delivery can be checked: its Owner saves the secret again.
    throw invalidSignature();
  }
  if (!isSigned(context, secret, body, headers)) throw invalidSignature();
  let event: { data?: { type?: unknown; id?: unknown } };
  try {
    event = JSON.parse(body.toString("utf8")) as typeof event;
  } catch {
    throw new ApiError(400, "invalid_request", "A delivery's body must be JSON.");
  }
  const type = event?.data?.type;
  const sessionId = event?.data?.id;
  if (typeof type !== "string" || !endingEvents.has(type) || typeof sessionId !== "string") return false;
  const { rows } = await context.db.query<{ runId: string; apiKeySealed: string }>(
    `select m.run_id as "runId", m.api_key_sealed as "apiKeySealed"
     from managed_agent_runs m join runs on runs.id = m.run_id
     where runs.state = 'running' and runs.runner_id = $1 and m.session_id = $2`,
    [runnerId, sessionId],
  );
  const run = rows[0];
  if (!run) return false;
  // The payload is thin and may be stale or out of order: the session as Anthropic has it now decides, as for polling.
  let why: string | null;
  try {
    why = await whySessionStopped(context, requireSecretBox(context.config).open(run.apiKeySealed), sessionId);
  } catch (error) {
    // Failing the delivery has Anthropic send it again shortly; polling is the backstop if every try fails.
    if (!(error instanceof SessionUnreadable)) throw error;
    throw new ApiError(502, "anthropic_unavailable", error.message);
  }
  if (!why) return false;
  await reports.endedWithoutFinishing(run.runId, why);
  return true;
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
      // A session Anthropic can't answer about now is read again at the next poll.
      if (!(error instanceof SessionUnreadable)) failures.push(error);
    }
  }
  // A Run whose refused start was unrecorded, as for a rate limit, has no row in `runs` left.
  const { rows: unfinished } = await context.db.query<{ runId: string }>(
    `select m.run_id as "runId" from managed_agent_runs m left join runs on runs.id = m.run_id
     where (m.revoked_at is null or m.vault_deleted_at is null or m.archived_at is null or m.transcript_fetched_at is null)
       and runs.state is distinct from 'running'`,
  );
  for (const { runId } of unfinished) await letGo(context, reports, runId).catch((error: unknown) => failures.push(error));
  if (failures.length > 0) throw failures[0];
}
/** Anthropic answered something other than the session or its events, such as a 429 or a 5xx: ask again later. */
class SessionUnreadable extends Error {}

/**
 * Why the session stopped without its Agent calling `finish`, or nothing while it is still at work. Throws
 * `SessionUnreadable` when Anthropic doesn't answer with the session or its events.
 */
async function whySessionStopped(context: Context, apiKey: string, sessionId: string): Promise<string | null> {
  const path = `v1/sessions/${encodeURIComponent(sessionId)}`;
  const session = await anthropic(context, apiKey, "GET", path);
  if (session.status === 404) return "Its session is gone from Anthropic, without the agent calling finish.";
  if (session.status !== 200) throw new SessionUnreadable(`Anthropic answered ${errorOf(session)} when Cronk read session ${sessionId}.`);
  if (session.body.status === "terminated") return "Its session terminated without the agent calling finish.";
  if (session.body.status !== "idle") return null;
  // The session carries no stop reason: its latest idle event does.
  const events = await anthropic(context, apiKey, "GET", `${path}/events?order=desc&limit=100`);
  if (events.status !== 200) throw new SessionUnreadable(`Anthropic answered ${errorOf(events)} when Cronk read the events of session ${sessionId}.`);
  const idle = ((events.body.data ?? []) as { type?: string; stop_reason?: { type?: string } }[]).find(
    (event) => event.type === "session.status_idle",
  );
  const stopReason = idle?.stop_reason?.type;
  if (!stopReason) return null;
  if (stopReason === "requires_action") {
    return "Its session needs a confirmation, which Cronk can't give: the session asked to confirm a tool call.";
  }
  if (stopReason === "budget_reached") {
    const cap = parseCost((session.body.budget as { max_list_cost?: unknown } | null | undefined)?.max_list_cost);
    return `Budget reached: its session stopped at the budget per Run${cap ? ` of ${shownCost(cap)}` : ""}, without the agent calling finish.`;
  }
  return `Its session went idle without calling finish (stop reason: ${stopReason}).`;
}

/**
 * Sets a fresh installation token on each Repository resource of a running Managed Agents Run's session whose token
 * expires within ten minutes, so a long Run keeps pushing: one fresh token per installation per pass. Ended Runs get
 * none. A token Cronk couldn't get or set now is tried again next time, while the one the session holds still works.
 * The server runs this every minute.
 */
export async function rotateRepositoryTokens(context: Context): Promise<void> {
  const { db, clock } = context;
  const { rows } = await db.query<{
    runId: string;
    sessionId: string;
    apiKeySealed: string;
    resourceId: string;
    repositoryId: string;
    fullName: string | null;
  }>(
    `select r.run_id as "runId", m.session_id as "sessionId", m.api_key_sealed as "apiKeySealed",
       r.resource_id as "resourceId", r.repository_id as "repositoryId", repositories.full_name as "fullName"
     from managed_agent_run_resources r
     join managed_agent_runs m on m.run_id = r.run_id
     join runs on runs.id = r.run_id
     left join repositories on repositories.id = r.repository_id
     where runs.state = 'running' and m.session_id is not null and r.token_expires_at <= $1
     order by r.run_id, r.resource_id`,
    [new Date(clock.now().getTime() + tokenRotationMarginMs)],
  );
  if (rows.length === 0) return;
  // One Run's failure doesn't hold up the others; the first is thrown at the end for the server to log.
  const failures: unknown[] = [];
  const tokenFor = freshTokens(context);
  for (const row of rows) {
    try {
      const repositoryId = Number(row.repositoryId);
      const { token, expiresAt } = await tokenFor({ id: repositoryId, fullName: row.fullName ?? `the Repository ${repositoryId}` });
      // The Run may have ended while this pass waited on GitHub or Anthropic: an ended Run gets no fresh token.
      const { rows: still } = await db.query("select from runs where id = $1 and state = 'running'", [row.runId]);
      if (still.length === 0) continue;
      const apiKey = requireSecretBox(context.config).open(row.apiKeySealed);
      const path = `v1/sessions/${encodeURIComponent(row.sessionId)}/resources/${encodeURIComponent(row.resourceId)}`;
      const answer = await anthropic(context, apiKey, "POST", path, { authorization_token: token });
      if (answer.status < 200 || answer.status >= 300) {
        throw new Error(`Anthropic answered ${errorOf(answer)} when Cronk set a fresh GitHub token on session ${row.sessionId}.`);
      }
      await db.query("update managed_agent_run_resources set token_expires_at = $3 where run_id = $1 and resource_id = $2", [
        row.runId,
        row.resourceId,
        expiresAt,
      ]);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
