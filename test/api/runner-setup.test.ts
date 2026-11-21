import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, setUp, signIn } from "../harness/flows.js";
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
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, json: json as any, text, headers: response.headers };
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${response.text}`).toBeLessThan(300);
  return response.json;
}

describe("model ids", () => {
  test("a Workspace ships with model ids for haiku, sonnet and opus, which an Admin changes and nobody else", async () => {
    const { workspace } = await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");

    expect((await ok("GET", `/api/workspaces/${workspace.id}/settings`, ada)).modelIds).toEqual([
      { label: "haiku", modelId: "claude-haiku-5-5" },
      { label: "sonnet", modelId: "claude-sonnet-5-5" },
      { label: "opus", modelId: "claude-opus-5-5" },
    ]);

    const modelIds = [
      { label: "haiku", modelId: "claude-haiku-6" },
      { label: "Fast", modelId: "claude-haiku-5-5" },
    ];
    const byBea = await call("PATCH", `/api/workspaces/${workspace.id}/settings`, { cookie: bea.cookie }, { modelIds });
    expect(byBea.status).toBe(403);
    expect((await ok("PATCH", `/api/workspaces/${workspace.id}/settings`, ada, { modelIds })).modelIds).toEqual(modelIds);
    expect((await ok("GET", `/api/workspaces/${workspace.id}/settings`, { cookie: bea.cookie })).modelIds).toEqual(modelIds);
  });

  test("two model ids for the same label, ignoring case, are refused", async () => {
    const { workspace } = await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };

    const refused = await call("PATCH", `/api/workspaces/${workspace.id}/settings`, ada, {
      modelIds: [
        { label: "haiku", modelId: "claude-haiku-5-5" },
        { label: "HAIKU", modelId: "claude-haiku-6" },
      ],
    });

    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe("duplicate_model_label");
  });
});

/**
 * Ada with a Project on the default board (haiku, sonnet and opus Steps) listing the Repository `cronkcorp/cronker`,
 * and her Agent `claude-max` pointed at her subscription Runner.
 */
async function adaWithProject() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  await createGitHubApp(cronk, ada.cookie);
  const installation = cronk.github.install(cronk.github.apps[0]!, "cronkcorp", ["cronker", "website"]);
  const [cronker, website] = [installation.repositories[0]!, installation.repositories[1]!];
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  await ok("POST", `/api/projects/${project.id}/repositories`, ada, { id: cronker.id });
  const runner = await ok("POST", "/api/runners", ada, { name: "Claude Max", kind: "subscription" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: runner.id });
  return { workspace, user, ada, project, runner, agent, website };
}

const standardPrompt =
  "You are started by Cronk. The text this session was fired with is a Brief from Cronk,\n" +
  "where this Repository's work is planned. Follow its instructions:\n" +
  "reach Cronk through the Cronk connector, work on the Ticket it names, and end by\n" +
  "calling Cronk's `finish` tool with the Run id and an Outcome, as the Brief says.\n" +
  "If the session was started without a Brief, stop without doing anything.";

describe("starting a Runner setup", () => {
  test("gives the command to paste and the plan: a routine per model label the board uses, with its model id", async () => {
    const { ada, project, runner, agent } = await adaWithProject();

    const started = await call("POST", `/api/runners/${runner.id}/setups`, ada, { projectId: project.id });

    expect(started.status).toBe(201);
    const { command, plan, warning, expiresAt } = started.json;
    expect(command).toMatch(new RegExp(`^claude "\\$\\(curl -fsSL '${cronk.url}/runner-setups/cronk_runner_setup_[A-Za-z0-9_-]+'\\)"$`));
    expect(expiresAt).toBe("2026-01-01T10:00:00.000Z");
    expect(warning).toBeNull();
    const routine = (label: string, modelId: string) => ({
      label,
      modelId,
      name: `Cronk · Cronker · ${label}`,
      repositories: ["cronkcorp/cronker"],
      prompt: standardPrompt,
      mcpUrl: `${cronk.url}/mcp`,
      branchPrefix: `claude/cronk-cronk-${label}`,
    });
    expect(plan).toEqual({
      project: { id: project.id, name: "Cronker", key: "CRONK" },
      agent: { id: agent.id, name: "claude-max" },
      routines: [
        routine("haiku", "claude-haiku-5-5"),
        routine("sonnet", "claude-sonnet-5-5"),
        routine("opus", "claude-opus-5-5"),
      ],
    });
  });
});

describe("a Runner setup is refused", () => {
  const refusal = async (as: Request, runnerId: string, body: unknown) => {
    const response = await call("POST", `/api/runners/${runnerId}/setups`, as, body);
    return { status: response.status, code: response.json.error?.code, message: response.json.error?.message };
  };

  test("on another User's Runner, as if it didn't exist", async () => {
    const { workspace, ada, project, runner } = await adaWithProject();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");

    expect(await refusal({ cookie: bea.cookie }, runner.id, { projectId: project.id })).toEqual(
      expect.objectContaining({ status: 404, code: "not_found" }),
    );
  });

  test("on a Runner that isn't a subscription Runner", async () => {
    const { ada, project } = await adaWithProject();
    const fake = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });

    expect(await refusal(ada, fake.id, { projectId: project.id })).toEqual(
      expect.objectContaining({ status: 409, code: "runner_has_no_triggers" }),
    );
  });

  test("for a Project the User can't see", async () => {
    const { workspace, ada, runner } = await adaWithProject();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const beas = await ok("POST", "/api/workspaces", { cookie: bea.cookie }, { name: "Bea's Workspace" });
    const beasProject = await ok("POST", `/api/workspaces/${beas.id}/projects`, { cookie: bea.cookie }, { name: "Bea's", key: "BEA" });

    expect(await refusal(ada, runner.id, { projectId: beasProject.id })).toEqual(
      expect.objectContaining({ status: 404, code: "project_not_found" }),
    );
  });

  test("for a Project with no Repository, saying so", async () => {
    const { workspace, ada, runner } = await adaWithProject();
    const bare = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Bare", key: "BARE" });

    expect(await refusal(ada, runner.id, { projectId: bare.id })).toEqual({
      status: 409,
      code: "project_has_no_repository",
      message: "Bare lists no Repository, so its routines would work on nothing: add one in its Project settings first.",
    });
  });

  test("for a board using a model label with no model id, naming the label", async () => {
    const { workspace, ada, project, runner } = await adaWithProject();
    await ok("PATCH", `/api/workspaces/${workspace.id}/settings`, ada, {
      modelIds: [
        { label: "haiku", modelId: "claude-haiku-5-5" },
        { label: "sonnet", modelId: "claude-sonnet-5-5" },
      ],
    });

    expect(await refusal(ada, runner.id, { projectId: project.id })).toEqual({
      status: 409,
      code: "no_model_id",
      message:
        "Cronker's board uses the model label opus, which has no model id in Ada's Workspace: an Admin adds one in the Workspace's Settings.",
    });
  });

  test("for an Agent's token", async () => {
    const { ada, project, runner, agent } = await adaWithProject();
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });

    expect(await refusal({ headers: { authorization: `Bearer ${secret}` } }, runner.id, { projectId: project.id })).toEqual(
      expect.objectContaining({ status: 403 }),
    );
  });

  test("with no Agent pointed at the Runner in the Project's Workspace, or several and none chosen", async () => {
    const { workspace, ada, project, runner, agent } = await adaWithProject();
    await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: null });
    expect(await refusal(ada, runner.id, { projectId: project.id })).toEqual(
      expect.objectContaining({ status: 409, code: "runner_has_no_agent" }),
    );

    await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: runner.id });
    const second = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-pro" });
    await ok("PATCH", `/api/agents/${second.id}`, ada, { runnerId: runner.id });
    expect(await refusal(ada, runner.id, { projectId: project.id })).toEqual(
      expect.objectContaining({ status: 400, code: "agent_required" }),
    );
    const elsewhere = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-idle" });
    expect(await refusal(ada, runner.id, { projectId: project.id, agentId: elsewhere.id })).toEqual(
      expect.objectContaining({ status: 404, code: "agent_not_found" }),
    );

    const chosen = await ok("POST", `/api/runners/${runner.id}/setups`, ada, { projectId: project.id, agentId: second.id });
    expect(chosen.plan.agent).toEqual({ id: second.id, name: "claude-pro" });
  });
});

test("a setup for a Project with several Repositories warns that the Transcript hook won't run there", async () => {
  const { ada, project, runner, website } = await adaWithProject();
  await ok("POST", `/api/projects/${project.id}/repositories`, ada, { id: website.id });

  const started = await ok("POST", `/api/runners/${runner.id}/setups`, ada, { projectId: project.id });

  expect(started.plan.routines[0].repositories).toEqual(["cronkcorp/cronker", "cronkcorp/website"]);
  expect(started.warning).toBe(
    "Cronker lists several Repositories, so each routine gets them all, and the Transcript hook doesn't run in " +
      "sessions with more than one: its Runs get no Transcripts and become lost if they work longer than the " +
      "lost-Run threshold without calling Cronk.",
  );
});

/** Starts a setup as Ada and fetches its instructions as the command's `curl` does. */
async function started(ada: Request, runnerId: string, projectId: string) {
  const setup = await ok("POST", `/api/runners/${runnerId}/setups`, ada, { projectId });
  const address = /curl -fsSL '([^']+)'/.exec(setup.command)![1]!;
  const setupToken = address.split("/").pop()!;
  const instructions = () => fetch(address);
  const report = (body: unknown, as: Request = {}) => call("POST", `/api/runner-setups/${setupToken}/triggers`, as, body);
  return { setup, address, instructions, report };
}

const allLabels = (ids: Record<string, string>) => ({
  triggers: Object.entries(ids).map(([label, triggerId]) => ({ label, triggerId })),
});

describe("the served instructions", () => {
  test("tell Claude Code which routines to create, with only the Cronk connector, and hand over the Transcript hook token", async () => {
    const { ada, project, runner, agent } = await adaWithProject();
    const { instructions } = await started(ada, runner.id, project.id);

    const response = await instructions();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/markdown/);
    const text = await response.text();
    for (const expected of [
      "RemoteTrigger",
      '"name": "Cronk · Cronker · haiku"',
      '"model": "claude-haiku-5-5"',
      '"model": "claude-opus-5-5"',
      '"url": "https://github.com/cronkcorp/cronker"',
      '"repo": "cronkcorp/cronker"',
      '"branches": ["claude/cronk-cronk-sonnet"]',
      '"cron_expression": ""',
      `"url": "${cronk.url}/mcp"`,
      "mcp_connections",
      "environment_id",
      "CRONK_TOKEN",
      ".claude/settings.json",
      "https://claude.ai/code/routines/",
      `${cronk.url}/api/runner-setups/`,
    ]) {
      expect(text).toContain(expected);
    }
    const hookToken = /CRONK_TOKEN=(cronk_agent_[A-Za-z0-9_-]+)/.exec(text)![1]!;
    const tokens = await ok("GET", `/api/agents/${agent.id}/tokens`, ada);
    expect(tokens.map((t: { name: string }) => t.name)).toEqual(["Transcript hook · Cronker"]);
    const asHook = await call("GET", `/api/projects/${project.id}`, { headers: { authorization: `Bearer ${hookToken}` } });
    expect(asHook.status).toBe(200);
  });

  test("are refused once the setup is used, saying to press the button again", async () => {
    const { ada, project, runner } = await adaWithProject();
    const { instructions, report } = await started(ada, runner.id, project.id);
    await report(allLabels({ haiku: "trig_h", sonnet: "trig_s", opus: "trig_o" }));

    const response = await instructions();

    expect(response.status).toBe(410);
    expect(await response.text()).toContain("press Set up with Claude Code again");
  });
});

describe("reporting back", () => {
  test("saves each routine as the Project's trigger for its label, waiting for its token, and replaces the Project's earlier ones", async () => {
    const { ada, project, runner } = await adaWithProject();
    await ok("POST", `/api/runners/${runner.id}/triggers`, ada, { model: "haiku", triggerId: "trig_all", token: "sk-all" });
    await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "fast",
      projectId: project.id,
      triggerId: "trig_old",
      token: "sk-old",
    });
    const { report } = await started(ada, runner.id, project.id);

    const reported = await report(allLabels({ haiku: "trig_h", sonnet: "trig_s", opus: "trig_o" }));

    expect(reported.status).toBe(200);
    const [listed] = await ok("GET", "/api/runners", ada);
    const waiting = (model: string, triggerId: string) => ({
      id: expect.any(String),
      model,
      projectId: project.id,
      triggerId,
      waitingForToken: true,
      routineUrl: `https://claude.ai/code/routines/${triggerId}`,
      createdAt: expect.any(String),
    });
    expect(listed.triggers).toEqual([
      expect.objectContaining({ model: "haiku", projectId: null, triggerId: "trig_all", waitingForToken: false }),
      waiting("haiku", "trig_h"),
      waiting("opus", "trig_o"),
      waiting("sonnet", "trig_s"),
    ]);
    expect(reported.json.triggers).toEqual(listed.triggers.slice(1).sort((a: { model: string }, b: { model: string }) => ["haiku", "sonnet", "opus"].indexOf(a.model) - ["haiku", "sonnet", "opus"].indexOf(b.model)));
  });

  test("is refused unless it names each of the plan's model labels once", async () => {
    const { ada, project, runner } = await adaWithProject();
    const { report } = await started(ada, runner.id, project.id);

    const missing = await report(allLabels({ haiku: "trig_h", sonnet: "trig_s" }));

    expect(missing.status).toBe(400);
    expect(missing.json.error.code).toBe("routines_not_matching_plan");
    expect((await ok("GET", "/api/runners", ada))[0].triggers).toEqual([]);
    expect((await report(allLabels({ haiku: "trig_h", sonnet: "trig_s", opus: "trig_o" }))).status).toBe(200);
  });

  test("is refused when the setup token was used, has expired or is unknown, saying to press the button again", async () => {
    const { ada, project, runner } = await adaWithProject();
    const triggers = allLabels({ haiku: "trig_h", sonnet: "trig_s", opus: "trig_o" });
    const used = await started(ada, runner.id, project.id);
    await used.report(triggers);
    const expired = await started(ada, runner.id, project.id);
    cronk.clock.advance(60 * 60 * 1000);

    const refusals = [
      await used.report(triggers),
      await expired.report(triggers),
      await call("POST", "/api/runner-setups/cronk_runner_setup_unknown/triggers", {}, triggers),
    ];

    expect(refusals.map((r) => [r.status, r.json.error.code])).toEqual([
      [410, "setup_used"],
      [410, "setup_expired"],
      [404, "setup_not_found"],
    ]);
    for (const refused of refusals) expect(refused.json.error.message).toContain("press Set up with Claude Code again");
    expect((await expired.instructions()).status).toBe(410);
  });

  test("is refused to an Agent's token", async () => {
    const { ada, project, runner, agent } = await adaWithProject();
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
    const { report } = await started(ada, runner.id, project.id);

    const refused = await report(allLabels({ haiku: "trig_h", sonnet: "trig_s", opus: "trig_o" }), {
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(refused.status).toBe(403);
    expect((await ok("GET", "/api/runners", ada))[0].triggers).toEqual([]);
  });
});

describe("a trigger waiting for its token", () => {
  test("never returns a token; a Run needing it couldn't start, with the reason, and starts once the token is pasted", async () => {
    const { workspace, ada, project, runner, agent } = await adaWithProject();
    const { report } = await started(ada, runner.id, project.id);
    await report(allLabels({ haiku: "trig_h", sonnet: "trig_s", opus: "trig_o" }));
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });

    expect(cronk.claude.fires).toEqual([]);
    const inbox = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(inbox.items.map((i: { run: unknown }) => i.run)).toEqual([
      expect.objectContaining({
        state: "refused",
        endReason:
          "Claude Max's trigger trig_h for haiku on Cronker is waiting for its token: its Owner generates one for the " +
          "routine in claude.ai and pastes it into the trigger on the Runner's card.",
      }),
    ]);

    const haiku = (await ok("GET", "/api/runners", ada))[0].triggers.find((t: { model: string }) => t.model === "haiku");
    cronk.claude.trigger("trig_h", "sk-ant-oat01-pasted");
    const pasted = await call("PUT", `/api/runners/${runner.id}/triggers/${haiku.id}/token`, ada, { token: " sk-ant-oat01-pasted " });
    expect(pasted.status).toBe(200);
    expect(pasted.json.triggers.find((t: { id: string }) => t.id === haiku.id)).toEqual(
      expect.objectContaining({ triggerId: "trig_h", waitingForToken: false }),
    );
    expect(pasted.text).not.toContain("sk-ant-oat01-pasted");
    expect(JSON.stringify(await ok("GET", "/api/runners", ada))).not.toContain("sk-ant-oat01-pasted");

    // Pasting the token into a waiting trigger rechecks the Ticket that couldn't start, without Retry.
    expect(cronk.claude.fires.map((f) => [f.triggerId, f.token])).toEqual([["trig_h", "sk-ant-oat01-pasted"]]);
    expect((await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).map((r: { state: string }) => r.state)).toEqual([
      "refused",
      "running",
    ]);
  });

  test("takes a token only from the Runner's Owner", async () => {
    const { workspace, ada, project, runner } = await adaWithProject();
    const { report } = await started(ada, runner.id, project.id);
    const { json } = await report(allLabels({ haiku: "trig_h", sonnet: "trig_s", opus: "trig_o" }));
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");

    const byBea = await call("PUT", `/api/runners/${runner.id}/triggers/${json.triggers[0].id}/token`, { cookie: bea.cookie }, { token: "x" });

    expect(byBea.status).toBe(404);
    expect((await ok("GET", "/api/runners", ada))[0].triggers.every((t: { waitingForToken: boolean }) => t.waitingForToken)).toBe(true);
  });
});

test("a setup for a Project whose board has no Step is refused, as it would create no routine", async () => {
  const { ada, project, runner } = await adaWithProject();
  for (const status of project.statuses) {
    await call("DELETE", `/api/projects/${project.id}/statuses/${status.id}/step`, ada);
  }

  const refused = await call("POST", `/api/runners/${runner.id}/setups`, ada, { projectId: project.id });

  expect(refused.status).toBe(409);
  expect(refused.json.error.code).toBe("board_has_no_steps");
});

describe("the Transcript hook token a setup hands over", () => {
  const hookTokenOf = async (instructions: () => Promise<Response>) =>
    /CRONK_TOKEN=(cronk_agent_[A-Za-z0-9_-]+)/.exec(await (await instructions()).text())![1]!;

  test("lasts once the setup is used, stops working when it expires unused, and goes when the button is pressed again", async () => {
    const { ada, project, runner, agent } = await adaWithProject();
    const asToken = (token: string) => call("GET", `/api/projects/${project.id}`, { headers: { authorization: `Bearer ${token}` } });
    const used = await started(ada, runner.id, project.id);
    const kept = await hookTokenOf(used.instructions);
    await used.report(allLabels({ haiku: "trig_h", sonnet: "trig_s", opus: "trig_o" }));
    const abandoned = await started(ada, runner.id, project.id);
    const unused = await hookTokenOf(abandoned.instructions);
    const pressedAgain = await started(ada, runner.id, project.id);
    const expiring = await hookTokenOf(pressedAgain.instructions);

    expect((await asToken(unused)).status).toBe(401);
    expect((await asToken(expiring)).status).toBe(200);
    expect((await ok("GET", `/api/agents/${agent.id}/tokens`, ada)).length).toBe(2);

    cronk.clock.advance(60 * 60 * 1000);
    expect((await asToken(expiring)).status).toBe(401);
    expect((await asToken(kept)).status).toBe(200);
    expect((await ok("GET", `/api/agents/${agent.id}/tokens`, ada)).map((t: { name: string }) => t.name)).toEqual([
      "Transcript hook · Cronker",
    ]);
  });
});

describe("the address of a setup's instructions", () => {
  test("is no Workspace's slug, so no Workspace's pages are under it", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    const created = await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Runner setups" } });

    expect(await created.json()).toMatchObject({ slug: "runner-setups-2" });
  });

  test("moves a Workspace that had it as its slug before to another", async () => {
    await cronk.stop();
    cronk = await startCronk({ migrateBefore: "0045_runner_setups.sql" });
    const { user } = await setUp(cronk);
    const id = crypto.randomUUID();
    await cronk.stage("insert into workspaces (id, name, slug, created_at) values ($1, 'Runner setups', 'runner-setups', now())", [id]);
    await cronk.stage("insert into memberships (workspace_id, user_id, created_at) values ($1, $2, now())", [id, user.id]);

    await cronk.upgrade();

    const me = await ok("GET", "/api/me", { cookie: await signIn(cronk) });
    expect(me.workspaces.find((w: { id: string }) => w.id === id).slug).toBe("runner-setups-2");
  });
});
