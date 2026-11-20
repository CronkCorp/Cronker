import { expect, pick, test } from "./fixtures.js";

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
