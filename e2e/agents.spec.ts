import { expect, test } from "./fixtures.js";

test("a User creates an Agent, issues a token shown once, and revokes it", async ({ page, cronk }) => {
  await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();

  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByLabel("Agent name").fill("claude-max");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page.getByRole("link", { name: "claude-max" }).click();
  await expect(page.getByRole("heading", { name: "claude-max" })).toBeVisible();

  await page.getByLabel("Token name").fill("laptop");
  await page.getByRole("button", { name: "Issue token" }).click();
  const secret = await page.getByLabel("Token laptop").inputValue();
  expect(secret).toMatch(/^cronk_agent_/);
  const asAgent = () => cronk.request("GET", "/api/agent", { headers: { authorization: `Bearer ${secret}` } });
  expect((await asAgent()).status).toBe(200);

  await page.reload();
  await expect(page.getByLabel("Token laptop")).toHaveCount(0);
  const row = page.getByRole("row", { name: /laptop/ });
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);
  expect((await asAgent()).status).toBe(401);
});
