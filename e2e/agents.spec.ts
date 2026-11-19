import { setUp, signIn } from "../test/harness/flows.js";
import { expect, test } from "./fixtures.js";

test("a User creates an Agent, issues a token shown once with Copy, and revokes it after confirming", async ({
  page,
  cronk,
}) => {
  await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: cronk.url });
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "New Agent" }).click();
  await page.getByRole("dialog", { name: "New Agent" }).getByLabel("Agent name").fill("claude-max");
  await page.getByRole("button", { name: "Create Agent" }).click();
  const card = page.getByRole("region", { name: "claude-max" });
  await expect(card).toContainText("No tokens");

  // Manage tokens opens a dialog over the Agents page.
  await card.getByRole("button", { name: "Manage tokens" }).click();
  const tokens = page.getByRole("dialog", { name: "Tokens of claude-max" });
  await tokens.getByLabel("Token name").fill("laptop");
  await tokens.getByRole("button", { name: "Issue token" }).click();
  const secret = await tokens.getByLabel("Token laptop").inputValue();
  expect(secret).toMatch(/^cronk_agent_/);
  await tokens.getByRole("button", { name: "Copy" }).click();
  await expect(tokens.getByRole("status")).toHaveText("Copied.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  const asAgent = () => cronk.request("GET", "/api/agent", { headers: { authorization: `Bearer ${secret}` } });
  expect((await asAgent()).status).toBe(200);

  // The secret is shown once: closing the dialog and opening it again shows only the token's row.
  await tokens.getByRole("button", { name: "Close" }).click();
  await expect(card).toContainText("1 token: laptop");
  await card.getByRole("button", { name: "Manage tokens" }).click();
  await expect(tokens.getByLabel("Token laptop")).toHaveCount(0);

  // Revoking asks first; Cancel keeps the token working.
  const row = tokens.getByRole("row", { name: /laptop/ });
  await row.getByRole("button", { name: "Revoke" }).click();
  const confirm = page.getByRole("dialog", { name: "Revoke laptop?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(row).toHaveCount(1);
  expect((await asAgent()).status).toBe(200);
  await row.getByRole("button", { name: "Revoke" }).click();
  await confirm.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);
  expect((await asAgent()).status).toBe(401);
});

test("an Agent's card counts the Tickets delegated to it and names those with a running Run", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const send = async (method: string, path: string, body?: unknown) =>
    (await cronk.request(method, path, { cookie, body })).json();
  const project = await send("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  const runner = await send("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await send("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await send("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const running = await send("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const resting = await send("POST", `/api/projects/${project.id}/tickets`, { title: "Tidy the board" });
  await send("PATCH", `/api/tickets/${running.id}`, { delegateId: agent.id });
  await send("PATCH", `/api/tickets/${resting.id}`, { delegateId: agent.id });
  await send("PATCH", `/api/tickets/${running.id}`, { statusId: triage });

  await page.context().addCookies([{ name: cookie.split("=")[0]!, value: cookie.split("=").slice(1).join("="), url: cronk.url }]);
  await page.goto(`${cronk.url}/workspaces/${workspace.id}/agents`);
  const card = page.getByRole("region", { name: "claude-max" });
  await expect(card).toContainText("2 delegated");
  await expect(card).toContainText("1 running");
  const runs = card.getByRole("list", { name: "Running Runs" });
  await expect(runs.getByRole("listitem")).toHaveCount(1);
  await expect(runs.getByRole("listitem")).toContainText("Run running");
  await runs.getByRole("link", { name: /Make it so/ }).click();
  await expect(page.getByRole("heading", { name: "Make it so" })).toBeVisible();
});
