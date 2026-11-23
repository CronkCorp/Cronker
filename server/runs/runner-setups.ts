import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { findAgent, type Agent } from "../agents/agents.js";
import { issueToken } from "../agents/tokens.js";
import { transaction, type Db, type Tx } from "../db.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { mcpPath } from "../mcp/paths.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import { userViewer } from "../identity/viewers.js";
import { findProject } from "../work/projects.js";
import { transcriptHook } from "../transcripts/hook.js";
import { findRunner, noSuchProject, noSuchRunner, replaceProjectTriggers, TriggerId, type Trigger } from "./runners.js";
import { modelIdOf, settingsOf } from "../workspaces/workspaces.js";

/**
 * Runner setups (ADR 0009): a one-time, short-lived handoff in which a User's own Claude Code creates a Project's
 * claude.ai routines, one per model label its board uses, and reports their trigger ids back. Cronk never holds a
 * claude.ai credential: it only serves the instructions and saves the trigger ids it is given, each as a trigger
 * waiting for the token the User pastes.
 */

/** How long a setup's command works. */
const setupLifetimeMs = 60 * 60 * 1000;

/** The prompt every routine gets, so its session acts on Cronk's Brief and stops when fired without one. */
export const routinePrompt =
  "You are started by Cronk. The text this session was fired with is a Brief from Cronk,\n" +
  "where this Repository's work is planned. Follow its instructions:\n" +
  "reach Cronk through the Cronk connector, work on the Ticket it names, and end by\n" +
  "calling Cronk's `finish` tool with the Run id and an Outcome, as the Brief says.\n" +
  "If the session was started without a Brief, stop without doing anything.";

export const RoutinePlan = Type.Object({
  label: Type.String({ description: "The model label, as the board's Steps name it." }),
  modelId: Type.String({ description: "The exact model id the Workspace maps the label to." }),
  name: Type.String({ description: "The routine's name in claude.ai." }),
  repositories: Type.Array(Type.String(), { description: "The Project's Repositories, by `owner/name`." }),
  prompt: Type.String({ description: "The routine's prompt." }),
  mcpUrl: Type.String({ format: "uri", description: "Cronk's MCP address, the only connector the routine gets." }),
  branchPrefix: Type.String({ description: "Each fire starts on its own branch under this prefix, such as `claude/cronk-cronk-haiku`." }),
});
export type RoutinePlan = Static<typeof RoutinePlan>;

export const SetupPlan = Type.Object({
  project: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String(), key: Type.String() }),
  agent: Type.Object(
    { id: Type.String({ format: "uuid" }), name: Type.String() },
    { description: "The Agent whose Transcript hook token the setup hands over." },
  ),
  routines: Type.Array(RoutinePlan, { description: "One routine per model label the Project's board uses." }),
});
export type SetupPlan = Static<typeof SetupPlan>;

export const StartedSetup = Type.Object({
  command: Type.String({
    description:
      "The command to paste into Claude Code: it fetches the setup's instructions, which hold its one-time setup token.",
  }),
  expiresAt: Type.String({ format: "date-time", description: "When the command stops working, an hour after it was made." }),
  warning: Type.Union([Type.String(), Type.Null()], {
    description: "What the User gives up, such as Transcripts for a Project with several Repositories; null for nothing.",
  }),
  plan: SetupPlan,
});
export type StartedSetup = Static<typeof StartedSetup>;

/** Where Cronk serves a setup's instructions, holding its setup token. */
export const instructionsPath = "/runner-setups/:setupToken";

/** The model labels a Project's Steps use, each once ignoring case, in board order. */
async function labelsOf({ db }: Context, projectId: string): Promise<string[]> {
  const { rows } = await db.query<{ model: string }>(
    `select steps.model from steps join statuses on statuses.id = steps.status_id
     where steps.project_id = $1 order by statuses.position`,
    [projectId],
  );
  const labels = new Map<string, string>();
  for (const { model } of rows) if (!labels.has(model.toLowerCase())) labels.set(model.toLowerCase(), model);
  return [...labels.values()];
}

/** What a Project with several Repositories gives up, as every routine gets them all. */
const severalRepositoriesWarning = (project: string) =>
  `${project} lists several Repositories, so each routine gets them all, and the Transcript hook doesn't run in ` +
  "sessions with more than one: its Runs get no Transcripts and become lost if they work longer than the lost-Run " +
  "threshold without calling Cronk.";

/** Text as a part of a branch name: lowercase letters and digits joined by hyphens. */
const branchSlug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Starts a Runner setup of one of the User's own subscription Runners for a Project they can see: plans a routine
 * per model label the Project's board uses, issues the Transcript hook token of the chosen Agent, and returns the
 * command to paste into Claude Code.
 */
/** The start-a-Runner-setup route's body. */
export const SetupStart = Type.Object({
  projectId: Type.String({ format: "uuid" }),
  agentId: Type.Optional(Type.String({ format: "uuid" })),
});
export type SetupStart = Static<typeof SetupStart>;

export async function startSetup(
  context: Context,
  userId: string,
  runnerId: string,
  input: SetupStart,
): Promise<StartedSetup> {
  const { db, clock, config } = context;
  const runner = await findRunner(context, userId, runnerId);
  if (!runner) throw noSuchRunner();
  if (runner.kind !== "subscription") {
    throw new ApiError(409, "runner_has_no_triggers", `${runner.name} is a Runner of the kind ${runner.kind}, which fires no routines.`);
  }
  const project = await findProject(db, userViewer(userId), input.projectId);
  if (!project) throw noSuchProject();

  const { rows: repositories } = await db.query<{ fullName: string }>(
    `select repositories.full_name as "fullName" from project_repositories
     join repositories on repositories.id = project_repositories.repository_id
     where project_repositories.project_id = $1 order by lower(repositories.full_name), repositories.id`,
    [project.id],
  );
  if (repositories.length === 0) {
    throw new ApiError(
      409,
      "project_has_no_repository",
      `${project.name} lists no Repository, so its routines would work on nothing: add one in its Project settings first.`,
    );
  }
  const settings = await settingsOf(db, project.workspaceId);
  const labels = await labelsOf(context, project.id);
  if (labels.length === 0) {
    throw new ApiError(
      409,
      "board_has_no_steps",
      `${project.name}'s board has no Step, so there is no model to create a routine for: add a Step in its Project settings first.`,
    );
  }
  const unmapped = labels.find((label) => modelIdOf(settings, label) === undefined);
  if (unmapped !== undefined) {
    const { rows } = await db.query<{ name: string }>("select name from workspaces where id = $1", [project.workspaceId]);
    throw new ApiError(
      409,
      "no_model_id",
      `${project.name}'s board uses the model label ${unmapped}, which has no model id in ${rows[0]!.name}: ` +
        "an Admin adds one in the Workspace's Settings.",
    );
  }
  const agent = await chooseAgent(context, userId, runner, project.workspaceId, input.agentId);

  const mcpUrl = `${config.publicUrl.origin}${mcpPath}`;
  const routines = labels.map((label) => ({
    label,
    modelId: modelIdOf(settings, label)!,
    name: `Cronk · ${project.name} · ${label}`,
    repositories: repositories.map((r) => r.fullName),
    prompt: routinePrompt,
    mcpUrl,
    branchPrefix: `claude/cronk-${branchSlug(project.key)}-${branchSlug(label)}`,
  }));
  const plan: SetupPlan = {
    project: { id: project.id, name: project.name, key: project.key },
    agent: { id: agent.id, name: agent.name },
    routines,
  };

  const box = requireSecretBox(config);
  const setupToken = issueSecret("runner_setup");
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + setupLifetimeMs);
  await transaction(db, async (tx) => {
    // Pressing the button again leaves the earlier unused setups of the Runner and Project to expire, without their tokens.
    await tx.query(
      `delete from agent_tokens where id in (
         select hook_token_id from runner_setups where runner_id = $1 and project_id = $2 and used_at is null)`,
      [runner.id, project.id],
    );
    // The environment's own Transcript hook token, revoked on its own on the Agent's page; only the instructions hand it
    // over. It expires with the setup unless the setup is used.
    const hook = await issueToken(tx, clock, agent, { name: `Transcript hook · ${project.name}`, access: "write", expiresAt });
    await tx.query(
      `insert into runner_setups (user_id, runner_id, project_id, agent_id, token_hash, hook_token_id, hook_token_sealed, plan,
         expires_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        runner.id,
        project.id,
        agent.id,
        hashSecret(setupToken),
        hook.token.id,
        box.seal(hook.secret),
        JSON.stringify(plan),
        expiresAt,
        now,
      ],
    );
  });
  const instructionsUrl = `${config.publicUrl.origin}${instructionsPath.replace(":setupToken", setupToken)}`;
  return {
    command: `claude "$(curl -fsSL '${instructionsUrl}')"`,
    expiresAt: expiresAt.toISOString(),
    warning: repositories.length > 1 ? severalRepositoriesWarning(project.name) : null,
    plan,
  };
}

/**
 * The Agent whose Transcript hook token the setup hands over: one of the User's own, pointed at the Runner, in the
 * Project's Workspace. The one there is, or the one chosen when there are several.
 */
async function chooseAgent(
  context: Context,
  userId: string,
  runner: { id: string; name: string },
  workspaceId: string,
  agentId: string | undefined,
): Promise<Agent> {
  const { rows } = await context.db.query<{ id: string }>(
    `select id from agents where runner_id = $1 and owner_id = $2 and workspace_id = $3 and removed_at is null
     order by lower(name), id`,
    [runner.id, userId, workspaceId],
  );
  if (agentId !== undefined) {
    if (!rows.some((r) => r.id === agentId)) {
      throw new ApiError(
        404,
        "agent_not_found",
        `You have no such Agent pointed at ${runner.name} in the Project's Workspace.`,
      );
    }
    return (await findAgent(context, agentId))!;
  }
  if (rows.length === 0) {
    throw new ApiError(
      409,
      "runner_has_no_agent",
      `None of your Agents in the Project's Workspace uses ${runner.name}: point one at it from its page first, so the ` +
        "setup can make its Transcript hook token.",
    );
  }
  if (rows.length > 1) {
    throw new ApiError(
      400,
      "agent_required",
      `Several of your Agents use ${runner.name}: choose which one's Transcript hook token the setup makes.`,
    );
  }
  return (await findAgent(context, rows[0]!.id))!;
}

/** A setup its setup token finds while it can still be used: not used yet, nor expired. */
interface UsableSetup {
  id: string;
  userId: string;
  runnerId: string;
  projectId: string;
  hookTokenSealed: string | null;
  plan: SetupPlan;
}

const pressAgain = "press Set up with Claude Code again on the Runner's card in Cronk for a new command.";

/** The setup a setup token belongs to, refusing one that is unknown, used or expired. */
async function usableSetup(db: Db | Tx, now: Date, setupToken: string, { lock = false } = {}): Promise<UsableSetup> {
  const { rows } = await db.query<UsableSetup & { usedAt: Date | null; expiresAt: Date }>(
    `select id, user_id as "userId", runner_id as "runnerId", project_id as "projectId",
       hook_token_sealed as "hookTokenSealed", plan, used_at as "usedAt", expires_at as "expiresAt"
     from runner_setups where token_hash = $1 ${lock ? "for update" : ""}`,
    [hashSecret(setupToken)],
  );
  const setup = rows[0];
  if (!setup) throw new ApiError(404, "setup_not_found", `Cronk knows no such Runner setup: ${pressAgain}`);
  if (setup.usedAt) throw new ApiError(410, "setup_used", `This Runner setup was already used: ${pressAgain}`);
  if (setup.expiresAt <= now) throw new ApiError(410, "setup_expired", `This Runner setup expired: ${pressAgain}`);
  return setup;
}

/**
 * The instructions Claude Code follows, as the User's own prompt: which routines to create through its
 * `RemoteTrigger` tool, the Transcript hook token to show the User, and how to report back. Everything that depends
 * on the shape of claude.ai's undocumented routines API (`/v1/code/triggers`) lives here, so Cronk can follow it
 * without a migration; #244 has what was checked by hand.
 */
export async function setupInstructions(context: Context, setupToken: string): Promise<string> {
  const { db, clock, config } = context;
  const setup = await usableSetup(db, clock.now(), setupToken);
  const hookToken = setup.hookTokenSealed ? requireSecretBox(config).open(setup.hookTokenSealed) : null;
  const cronk = config.publicUrl.origin;
  const reportUrl = `${cronk}/api/runner-setups/${setupToken}/triggers`;
  const { plan } = setup;
  const [first] = plan.routines;
  const mcpUrl = first?.mcpUrl ?? `${cronk}${mcpPath}`;
  const hook = transcriptHook(config.publicUrl);

  const body = (routine: RoutinePlan) =>
    JSON.stringify(
      {
        name: routine.name,
        cron_expression: "",
        enabled: true,
        job_config: {
          ccr: {
            environment_id: "<ENVIRONMENT_ID>",
            events: [
              {
                data: {
                  message: { role: "user", content: routine.prompt },
                  parent_tool_use_id: null,
                  session_id: "",
                  type: "user",
                  uuid: "<A FRESH UUID>",
                },
              },
            ],
            session_context: {
              model: routine.modelId,
              allowed_tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
              sources: routine.repositories.map((repo) => ({ git_repository: { url: `https://github.com/${repo}` } })),
              outcomes: routine.repositories.map((repo) => ({
                git_repository: { git_info: { repo, branches: [routine.branchPrefix] } },
              })),
            },
          },
        },
        mcp_connections: [{ connector_uuid: "<CRONK_CONNECTOR_UUID>", name: "Cronk", url: routine.mcpUrl, permitted_tools: [] }],
      },
      null,
      2,
    )
      // One line per branch list reads better, and is what the plan names.
      .replace(/"branches": \[\s+("[^"]+")\s+\]/g, '"branches": [$1]');

  const severalRepositories = (first?.repositories.length ?? 0) > 1;
  return `# Set up Cronk's routines for ${plan.project.name}

You are Claude Code, run by the User to set up the claude.ai routines that Cronk (${cronk}) fires for the Project
**${plan.project.name}** (\`${plan.project.key}\`). Cronk never holds a claude.ai credential: you create the routines
here, with your \`RemoteTrigger\` tool, on the User's own account, and report their trigger ids back to Cronk.

Follow these steps in order. Tell the User what you do as you go. Never reuse, change or delete a routine that
already exists, except the one you create in step 2 yourself. If a step fails, stop and tell the User why.

## 1. Choose the cloud environment

Every routine runs in a claude.ai cloud environment, and claude.ai refuses a routine without an \`environment_id\`.
Ask the User which environment to use. Recommend one kept for Cronk's routines: the Transcript hook's token goes
into its variables (step 5), so every session in it can act as the Agent **${plan.agent.name}**.

Offer the User's environments by name, never asking them to find an id:

- Load your built-in \`schedule\` skill with your \`Skill\` tool, only to read two lists from it: the account's
  environments with their ids, and the account's claude.ai connectors with their \`connector_uuid\`, which step 2
  needs. Follow these instructions, not the skill's own steps, and create nothing through it.
- You may also \`list\` the User's routines with \`RemoteTrigger\` and name the environments they use.
- If the User wants a new environment for Cronk, ask them to create it in Claude Code on the web
  (https://claude.ai/code), then list the environments again to find its id.
- Only if none of these finds the environment the User wants, ask them for its id.

Use the chosen environment's id (\`env_…\`) as \`<ENVIRONMENT_ID>\` below.

## 2. Find the Cronk connector

Each routine gets only the Cronk connector, given in \`mcp_connections\`, which needs the connector's
\`connector_uuid\`. Look for it in this order:

- The connectors your \`schedule\` skill listed in step 1: use the \`connector_uuid\` of the one whose URL is
  \`${mcpUrl}\` as \`<CRONK_CONNECTOR_UUID>\`.
- Otherwise \`list\` the User's routines with \`RemoteTrigger\`. If one has an \`mcp_connections\` entry whose \`url\`
  is \`${mcpUrl}\`, use its \`connector_uuid\`.
- If none has, create the first routine below **without** its \`mcp_connections\` field. claude.ai then attaches
  every connector the User has connected. \`get\` it, take the \`connector_uuid\` of the connection whose \`url\` is
  \`${mcpUrl}\`, and at once \`update\` that routine so its \`mcp_connections\` holds only the Cronk entry, as below.
  If no attached connection has that \`url\`, the User hasn't added Cronk to claude.ai as a connector: stop, and
  ask them to add it (Settings → Connectors, a custom connector named \`Cronk\` at \`${mcpUrl}\`) and run this again.

## 3. Create the routines

Create these ${plan.routines.length} routine${plan.routines.length === 1 ? "" : "s"} with \`RemoteTrigger\`'s \`create\`, one per model label
${plan.project.name}'s board uses. Send each body exactly as given, with \`<ENVIRONMENT_ID>\`,
\`<CRONK_CONNECTOR_UUID>\` and \`<A FRESH UUID>\` (a new random UUID for each) filled in. Each has no schedule (Cronk
fires it), only the Project's ${severalRepositories ? "Repositories" : "Repository"}, only the Cronk connector, and a \`claude/…\` branch prefix, so each
fire starts on a branch of its own. Note each routine's trigger id (\`trig_…\`) from the answer.

${plan.routines
  .map((routine) => `### ${routine.label}: ${routine.modelId}\n\n\`\`\`json\n${body(routine)}\n\`\`\``)
  .join("\n\n")}

## 4. Report the trigger ids back to Cronk

Once every routine is created, send all their trigger ids to Cronk in one request. This setup works once: it makes
each a trigger of the User's Runner for ${plan.project.name}, waiting for its token, in place of the Project's earlier
ones.

\`\`\`sh
curl -fsS -X POST '${reportUrl}' \\
  -H 'content-type: application/json' \\
  -d '{"triggers": [${plan.routines.map((r) => `{"label": "${r.label}", "triggerId": "<trig_… of ${r.label}>"}`).join(", ")}]}'
\`\`\`

If Cronk refuses it, show the User its answer.

## 5. Tell the User what is left

claude.ai keeps no environment variables on a routine, and has no documented way to make a routine's token, so tell
the User, in this order:

1. The routines you created, each with its link, \`https://claude.ai/code/routines/<trig_…>\`.
2. For each, to open that link, generate an API token for it, and paste the token into the trigger waiting for it on
   the Runner's card in Cronk (${cronk}/runners). Generating a new token revokes the routine's previous one.
3. To add the Transcript hook token below to the variables of the environment they chose, as one line:

   \`\`\`
   ${hookToken ? `${hook.tokenVariable}=${hookToken}` : `${hook.tokenVariable}=<the Transcript hook token>`}
   \`\`\`

   It is ${plan.agent.name}'s token, listed on its page in Cronk as *Transcript hook · ${plan.project.name}*, where
   revoking it stops only the hook. Show it to the User only; never write it into a file or the Repository.
4. To give that environment **Full** network access, or add \`${config.publicUrl.host}\` to its **Limited** allowlist,
   so the hook can reach Cronk.
5. If the Repository has no \`.claude/settings.json\` running Cronk's Transcript hook yet, to commit this snippet as
   \`.claude/settings.json\` in ${first?.repositories.join(", ") ?? "the Repository"}, merging it into any hooks already there:

   \`\`\`json
${JSON.stringify(hook.settings, null, 2)
  .split("\n")
  .map((line) => `   ${line}`)
  .join("\n")}
   \`\`\`
${severalRepositories ? `\nTell the User this too: ${severalRepositoriesWarning(plan.project.name)}\n` : ""}`;
}

/**
 * Saves the routines a setup created, by their trigger ids, each as the Project's trigger for its model label on the
 * Runner, waiting for its token; the Project's earlier triggers on the Runner go, those for all Projects stay. Marks
 * the setup used, so its command and instructions stop working.
 */
/** The report-a-setup's-routines route's body: the trigger id of the routine made for each model label. */
export const SetupReport = Type.Object({
  triggers: Type.Array(
    Type.Object({
      label: Type.String({ minLength: 1, maxLength: 50, pattern: "\\S", description: "The model label, as the plan names it." }),
      triggerId: TriggerId,
    }),
    { maxItems: 50 },
  ),
});
export type SetupReport = Static<typeof SetupReport>;

export async function reportSetup(
  context: Context,
  setupToken: string,
  input: SetupReport,
): Promise<{ triggers: Trigger[] }> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const now = clock.now();
    const setup = await usableSetup(tx, now, setupToken, { lock: true });
    const byLabel = new Map(input.triggers.map((t) => [t.label.trim().toLowerCase(), t.triggerId.trim()]));
    const labels = setup.plan.routines.map((r) => r.label);
    if (byLabel.size !== input.triggers.length || byLabel.size !== labels.length || labels.some((l) => !byLabel.has(l.toLowerCase()))) {
      throw new ApiError(
        400,
        "routines_not_matching_plan",
        `Report one trigger id for each of the setup's model labels, once each: ${labels.join(", ")}.`,
      );
    }
    const triggers = await replaceProjectTriggers(
      tx,
      setup.runnerId,
      setup.projectId,
      labels.map((label) => ({ model: label, triggerId: byLabel.get(label.toLowerCase())! })),
      now,
    );
    // Used, its Transcript hook token lasts until revoked on the Agent's page.
    await tx.query("update agent_tokens set expires_at = null where id = (select hook_token_id from runner_setups where id = $1)", [
      setup.id,
    ]);
    await tx.query("update runner_setups set used_at = $2, hook_token_sealed = null where id = $1", [setup.id, now]);
    live.publishToOwner(tx, setup.userId, { type: "runner.changed", runnerId: setup.runnerId });
    return { triggers };
  });
}
