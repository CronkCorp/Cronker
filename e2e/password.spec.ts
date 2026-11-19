import { expect, test } from "./fixtures.js";

test("a User changes their password on its own page outside the frame, then goes back", async ({ page, cronk }) => {
  await cronk.request("POST", "/api/setup", {
    body: { setupCode: cronk.setupCode(), email: "ada@example.com", password: "correct horse battery", workspaceName: "Ada's Workspace" },
  });
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();

  await page.getByRole("button", { name: "ada@example.com" }).click();
  await page.getByRole("menuitem", { name: "Password" }).click();
  await expect(page.getByRole("heading", { name: "Change your password" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);

  await page.getByLabel("Current password").fill("correct horse battery");
  await page.getByLabel("New password").fill("a newer, longer password");
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByRole("status")).toHaveText("Password changed. Your other sign-ins have ended.");

  // A way back, sized to its label like every button outside the sign-in form.
  const back = page.getByRole("link", { name: "Back to Cronk" });
  expect((await back.boundingBox())!.width).toBeLessThan((await page.getByLabel("New password").boundingBox())!.width / 2);
  await back.click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();
});
