import { setUp, signIn } from "../test/harness/flows.js";
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

test("save a trigger waiting for its token, then paste the token from its routine and the Ticket that couldn't start starts", async ({
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
  await expect(row).toContainText("Waiting for token");
  const paste = card.getByRole("form", { name: "Paste the token of trig_01Haiku" });
  await expect(paste.getByRole("link", { name: "open trig_01Haiku in claude.ai" })).toHaveAttribute(
    "href",
    "https://claude.ai/code/routines/trig_01Haiku",
  );
  await expect(paste).toContainText("Generating a new token in claude.ai revokes the previous one");

  // Its Run can't start until the token is pasted.
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: triage });
  expect((await call("GET", `/api/tickets/${ticket.id}/runs`))[0].endReason).toContain("waiting for its token");

  cronk.claude.trigger("trig_01Haiku", "sk-ant-oat01-secret");
  await paste.getByLabel("Token").fill("sk-ant-oat01-secret");
  await paste.getByRole("button", { name: "Save token" }).click();
  await expect(row).not.toContainText("Waiting for token");
  await expect(paste).toHaveCount(0);
  expect(await page.content()).not.toContain("sk-ant-oat01-secret");
  await expect.poll(() => cronk.claude.fires.map((f) => f.triggerId)).toEqual(["trig_01Haiku"]);
});
