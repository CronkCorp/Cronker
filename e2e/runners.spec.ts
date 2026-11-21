import { createGitHubApp, setUp, signIn } from "../test/harness/flows.js";
import { expect, pick, signInInBrowser, test } from "./fixtures.js";

test("set up a subscription Runner, point an Agent at it, and follow a Run to its claude.ai session, then remove the trigger", async ({
  page,
  cronk,
}) => {
  const setup = await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  const { workspace } = await setup.json();
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await post(`/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const agent = await post(`/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  cronk.claude.trigger("trig_haiku", "sk-ant-oat01-secret");

  await page.getByRole("link", { name: "Runners" }).click();
  await page.getByLabel("Runner name").fill("Claude Max");
  await page.getByRole("button", { name: "Set up a subscription Runner" }).click();
  const runner = page.getByRole("region", { name: "Claude Max" });
  await expect(runner).toContainText("No triggers yet");
  await runner.getByLabel("Model").fill("haiku");
  await runner.getByLabel("Trigger id").fill("trig_haiku");
  await runner.getByLabel("Trigger token").fill("sk-ant-oat01-secret");
  await runner.getByRole("button", { name: "Save trigger" }).click();
  await expect(runner.getByRole("row", { name: /haiku/ })).toContainText("All Projects");
  await expect(runner.getByRole("row", { name: /haiku/ })).toContainText("trig_haiku");
  await expect(runner.getByLabel("Trigger token")).toHaveValue("");
  await page.reload();
  await expect(page.getByRole("row", { name: /haiku/ })).toContainText("trig_haiku");
  expect(await page.content()).not.toContain("sk-ant-oat01-secret");

  await page.goto(`${cronk.url}/workspaces/${workspace.id}/agents/${agent.id}`);
  await page.getByLabel("Runner").selectOption("Claude Max");
  await expect(page.getByLabel("Runner")).toHaveValue(/.+/);

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  await pick(page, "Delegate", "claude-max");
  await pick(page, "Status", "Triage");
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByRole("listitem").filter({ hasText: "Triage · claude-max · haiku" })).toContainText("Run running");
  await expect(timeline.getByRole("link", { name: "Session" })).toHaveAttribute(
    "href",
    "https://claude.ai/code/session_01STANDIN",
  );
  expect(cronk.claude.fires.map((f) => f.triggerId)).toEqual(["trig_haiku"]);

  // Removing a trigger loses its token for good, so it asks first.
  await page.getByRole("link", { name: "Runners" }).click();
  const haiku = runner.getByRole("row", { name: /haiku/ });
  await haiku.getByRole("button", { name: "Remove" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove the haiku trigger?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(haiku).toHaveCount(1);
  await haiku.getByRole("button", { name: "Remove" }).click();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(runner).toContainText("No triggers yet");
});

test("remove a Runner after confirming what stops working, leaving its Agent to choose another", async ({ page, cronk }) => {
  const setup = await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  const { workspace } = await setup.json();
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const send = async (method: string, path: string, body: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const runner = await send("POST", "/api/runners", { name: "Claude Max", kind: "subscription" });
  await send("POST", `/api/runners/${runner.id}/triggers`, { model: "haiku", triggerId: "trig_haiku", token: "sk-ant-oat01-secret" });
  const agent = await send("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await send("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });

  await page.getByRole("link", { name: "Runners" }).click();
  const card = page.getByRole("region", { name: "Claude Max" });
  await card.getByRole("button", { name: "More for Claude Max" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  const confirm = page.getByRole("dialog", { name: "Remove Claude Max?" });
  await expect(confirm).toContainText("claude-max");
  await expect(confirm).toContainText("haiku");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(card).toHaveCount(1);

  await card.getByRole("button", { name: "More for Claude Max" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  await confirm.getByRole("button", { name: "Remove" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText("No Runners yet.")).toBeVisible();

  await page.goto(`${cronk.url}/workspaces/${workspace.id}/agents/${agent.id}`);
  await expect(page.getByLabel("Runner")).toHaveValue("");
  await expect(page.getByText("Choose a Runner for its Runs to start.")).toBeVisible();
});

test("a subscription Runner shows the Transcript hook's snippet with Cronk's address, and makes a Transcript hook token revoked on its own", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const runner = await call("POST", "/api/runners", { name: "Claude Max", kind: "subscription" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  await call("POST", `/api/agents/${agent.id}/tokens`, { name: "laptop", access: "full" });
  await signInInBrowser(page, cronk);

  await page.getByRole("link", { name: "Runners" }).click();
  const hook = page.getByRole("region", { name: "Claude Max" }).getByRole("group", { name: "Transcript hook" });
  const snippet = hook.getByLabel("settings.json snippet");
  await expect(snippet).toContainText(`curl -fsS '${cronk.url}/hooks/transcript.mjs'`);
  await expect(snippet).toContainText(`CRONK_URL='${cronk.url}'`);
  await expect(snippet).toContainText('"Stop"');
  await expect(snippet).toContainText('"PostToolUse"');
  await expect(hook).toContainText("Hooks only run in cloud sessions with one Repository");
  await expect(hook).toContainText(`add ${new URL(cronk.url).host} to its Limited allowlist`);

  await hook.getByRole("button", { name: "Make a Transcript hook token for claude-max" }).click();
  await expect(hook.getByLabel("CRONK_TOKEN for claude-max")).toHaveValue(/^cronk_agent_/);

  // It is one of the Agent's tokens, revoked on its own there.
  await page.goto(`${cronk.url}/workspaces/${workspace.id}/agents`);
  await page.getByRole("button", { name: "Manage tokens" }).click();
  const tokens = page.getByRole("dialog", { name: "Tokens of claude-max" });
  await tokens.getByRole("row", { name: /Transcript hook/ }).getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("dialog", { name: "Revoke Transcript hook?" }).getByRole("button", { name: "Revoke" }).click();
  await expect(tokens.getByRole("row", { name: /Transcript hook/ })).toHaveCount(0);
  await expect(tokens.getByRole("row", { name: /laptop/ })).toHaveCount(1);
});

test("set up a Project's routines with Claude Code: the command, the routines reported back, and pasting a waiting trigger's token", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const installation = cronk.github.install(cronk.github.apps[0]!, "cronkcorp", ["cronker"]);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await call("POST", `/api/projects/${project.id}/repositories`, { id: installation.repositories[0]!.id });
  const runner = await call("POST", "/api/runners", { name: "Claude Max", kind: "subscription" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  await signInInBrowser(page, cronk);

  await page.getByRole("link", { name: "Runners" }).click();
  const card = page.getByRole("region", { name: "Claude Max" });
  await card.getByRole("button", { name: "Set up with Claude Code" }).click();
  const dialog = page.getByRole("dialog", { name: "Set up with Claude Code" });
  await dialog.getByLabel("Project").selectOption("Cronker");
  await dialog.getByRole("button", { name: "Make the command" }).click();
  const command = dialog.getByLabel("Command");
  await expect(command).toHaveValue(new RegExp(`^claude "\\$\\(curl -fsSL '${cronk.url}/runner-setups/cronk_runner_setup_`));
  await expect(dialog.getByRole("table", { name: "Routines" }).getByRole("row", { name: /opus/ })).toContainText("claude-opus-5-5");
  await expect(dialog.getByRole("button", { name: "Copy command" })).toBeVisible();

  // Claude Code follows the instructions and reports the routines back; the card shows them at once.
  const address = /curl -fsSL '([^']+)'/.exec(await command.inputValue())![1]!;
  expect((await fetch(address)).status).toBe(200);
  const reported = await cronk.request("POST", `/api/runner-setups/${address.split("/").pop()}/triggers`, {
    body: {
      triggers: [
        { label: "haiku", triggerId: "trig_haiku" },
        { label: "sonnet", triggerId: "trig_sonnet" },
        { label: "opus", triggerId: "trig_opus" },
      ],
    },
  });
  expect(reported.status).toBe(200);
  await dialog.getByRole("button", { name: "Done" }).click();
  const haiku = card.getByRole("row", { name: /haiku/ });
  await expect(haiku).toContainText("Cronker");
  await expect(haiku).toContainText("waiting for token");

  const waiting = card.getByRole("group", { name: "Waiting for tokens" });
  await expect(waiting).toContainText("Generating a new token revokes the routine's previous one");
  const paste = waiting.getByRole("form", { name: "Token for haiku on Cronker" });
  await expect(paste.getByRole("link", { name: "Open routine in claude.ai" })).toHaveAttribute(
    "href",
    "https://claude.ai/code/routines/trig_haiku",
  );
  await paste.getByLabel("Token for haiku on Cronker").fill("sk-ant-oat01-pasted");
  await paste.getByRole("button", { name: "Save token" }).click();
  await expect(haiku).not.toContainText("waiting for token");
  await expect(card.getByRole("row", { name: /opus/ })).toContainText("waiting for token");
  await expect(waiting.getByRole("form")).toHaveCount(2);
  expect(await page.content()).not.toContain("sk-ant-oat01-pasted");
});

test("set up a Managed Agents Runner with an API key, after a rejected one is reported", async ({ page, cronk }) => {
  await setUp(cronk);
  cronk.managedAgents.apiKey("sk-ant-api03-ada-secret");
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "Runners" }).click();

  await page.getByLabel("Runner name").fill("Claude API");
  await page.getByLabel("Kind").selectOption("managed_agents");
  await page.getByLabel("Anthropic API key").fill("sk-ant-wrong");
  await page.getByRole("button", { name: "Set up a Managed Agents Runner" }).click();
  await expect(page.getByRole("alert")).toContainText("Anthropic rejected the API key");
  await expect(page.getByRole("region", { name: "Claude API" })).toHaveCount(0);

  await page.getByLabel("Anthropic API key").fill("sk-ant-api03-ada-secret");
  await page.getByRole("button", { name: "Set up a Managed Agents Runner" }).click();
  const runner = page.getByRole("region", { name: "Claude API" });
  // The stand-in holds the agent and environment once the card shows, not as soon as the button is pressed.
  await expect(runner.getByRole("group", { name: "Managed Agents" })).toBeVisible();
  const [agent] = cronk.managedAgents.agents;
  const [environment] = cronk.managedAgents.environments;
  await expect(runner.getByRole("group", { name: "Managed Agents" })).toContainText(agent!.id);
  await expect(runner.getByRole("group", { name: "Managed Agents" })).toContainText(environment!.id);
  await expect(runner).toContainText("managed_agents");
  await expect(runner).not.toContainText("Triggers");
  await expect(page.getByRole("button", { name: "Set up a subscription Runner" })).toBeVisible();
});

test("add a Managed Agents Runner's webhook: copy its URL, and save its signing secret, after a wrong one is refused", async ({
  page,
  cronk,
}) => {
  await setUp(cronk);
  cronk.managedAgents.apiKey("sk-ant-api03-ada-secret");
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "Runners" }).click();
  await page.getByLabel("Runner name").fill("Claude API");
  await page.getByLabel("Kind").selectOption("managed_agents");
  await page.getByLabel("Anthropic API key").fill("sk-ant-api03-ada-secret");
  await page.getByRole("button", { name: "Set up a Managed Agents Runner" }).click();
  const webhook = page.getByRole("region", { name: "Claude API" }).getByRole("group", { name: "Webhook" });
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const [runner] = await (await cronk.request("GET", "/api/runners", { cookie })).json();

  await expect(webhook.getByLabel("Webhook URL")).toHaveText(`${cronk.url}/api/runners/${runner.id}/managed-agents/webhook`);
  await expect(webhook.getByRole("button", { name: "Copy URL" })).toBeVisible();
  await expect(webhook).toContainText("No secret yet");

  await webhook.getByLabel("Signing secret", { exact: true }).fill("sk-ant-api03-not-a-secret");
  await webhook.getByRole("button", { name: "Save secret" }).click();
  await expect(webhook.getByRole("alert")).toContainText("whsec_");

  const secret = cronk.managedAgents.webhookSecret();
  await webhook.getByLabel("Signing secret", { exact: true }).fill(secret);
  await webhook.getByRole("button", { name: "Save secret" }).click();
  await expect(webhook.getByRole("status")).toContainText("Saved");
  await expect(webhook).toContainText("A secret is saved");
  await expect(webhook.getByLabel("Signing secret", { exact: true })).toHaveValue("");
  await page.reload();
  await expect(page.getByRole("group", { name: "Webhook" }).getByRole("button", { name: "Replace secret" })).toBeVisible();
  expect(await page.content()).not.toContain(secret.slice(6));

  await page.getByRole("group", { name: "Webhook" }).getByRole("button", { name: "Forget it" }).click();
  await page.getByRole("dialog", { name: "Forget the webhook signing secret?" }).getByRole("button", { name: "Forget" }).click();
  await expect(page.getByRole("group", { name: "Webhook" })).toContainText("No secret yet");
});

test("save a trigger waiting for its token on the card, then paste the token and the Ticket that couldn't start starts", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const runner = await call("POST", "/api/runners", { name: "Claude Max", kind: "subscription" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  await signInInBrowser(page, cronk);

  await page.getByRole("link", { name: "Runners" }).click();
  const card = page.getByRole("region", { name: "Claude Max" });
  await card.getByLabel("Model").fill("haiku");
  await card.getByRole("combobox", { name: "For" }).selectOption("Cronker only");
  await card.getByLabel("Trigger id").fill("trig_01Haiku");
  await card.getByRole("button", { name: "Save trigger" }).click();
  const row = card.getByRole("row", { name: /haiku/ });
  await expect(row).toContainText("waiting for token");
  const paste = card.getByRole("group", { name: "Waiting for tokens" }).getByRole("form", { name: "Token for haiku on Cronker" });
  await expect(paste.getByRole("link", { name: "Open routine in claude.ai" })).toHaveAttribute(
    "href",
    "https://claude.ai/code/routines/trig_01Haiku",
  );

  // Its Run can't start until the token is pasted.
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: triage });
  expect((await call("GET", `/api/tickets/${ticket.id}/runs`))[0].endReason).toContain("waiting for its token");

  cronk.claude.trigger("trig_01Haiku", "sk-ant-oat01-secret");
  await paste.getByLabel("Token for haiku on Cronker").fill("sk-ant-oat01-secret");
  await paste.getByRole("button", { name: "Save token" }).click();
  await expect(row).not.toContainText("waiting for token");
  await expect(paste).toHaveCount(0);
  expect(await page.content()).not.toContain("sk-ant-oat01-secret");
  await expect.poll(() => cronk.claude.fires.map((f) => f.triggerId)).toEqual(["trig_01Haiku"]);
});

test("set a Managed Agents Runner's budget per Run, and see a Run stopped by it: its cost on the Run, the Ticket and the Runner", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  cronk.managedAgents.apiKey("sk-ant-api03-ada-secret");
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const runner = await call("POST", "/api/runners", { name: "Claude API", kind: "managed_agents", apiKey: "sk-ant-api03-ada-secret" });
  const created = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-api" });
  const agent = await call("PATCH", `/api/agents/${created.id}`, { runnerId: runner.id });
  await signInInBrowser(page, cronk);
  await page.getByRole("link", { name: "Runners" }).click();
  const card = page.getByRole("region", { name: "Claude API" });
  await expect(card).toContainText("$0.00 this month");
  await expect(card.getByLabel("Budget per Run (USD)")).toHaveValue("");

  await card.getByLabel("Budget per Run (USD)").fill("5");
  await card.getByRole("button", { name: "Save budget" }).click();
  await expect(card.locator(".runner-budget").getByRole("status")).toHaveText("Saved.");
  await page.reload();
  await expect(card.getByLabel("Budget per Run (USD)")).toHaveValue("5.00");

  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: triage });
  const session = cronk.managedAgents.sessions.at(-1)!;
  expect(session.body.budget).toEqual({ type: "limit", max_list_cost: { amount: "500", currency: "USD" } });
  cronk.managedAgents.charge(session.id, 512);
  cronk.managedAgents.idle(session.id, "budget_reached");
  await cronk.pollManagedAgentsSessions();
  await expect(card).toContainText("$5.12 this month");

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const run = page.locator(".entry-run");
  await expect(run).toContainText("$5.12");
  await expect(run).toContainText("Budget reached");
  await expect(page.locator(".field-row").filter({ hasText: "Cost" })).toContainText("$5.12");
  await expect(page.getByRole("region", { name: "Run" }).getByRole("button", { name: "Retry" })).toBeVisible();
});
