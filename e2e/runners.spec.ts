import { expect, pick, test } from "./fixtures.js";

test("set up a subscription Runner, point an Agent at it, and follow a Run to its claude.ai session", async ({
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
});
