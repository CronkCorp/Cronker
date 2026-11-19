import { setUp, signIn } from "../test/harness/flows.js";
import { expect, test } from "./fixtures.js";

test("the sidebar holds the main links, and at phone width becomes a strip with the rest in a menu", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = await created.json();
  await cronk.request("POST", `/api/projects/${project.id}/tickets`, { cookie, body: { title: "Make it so" } });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await expect(sidebar.getByRole("link", { name: "CRONK Cronker" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Menu" })).toBeHidden();

  // Exactly one active item: a Ticket's page marks its Project.
  await sidebar.getByRole("link", { name: "CRONK Cronker" }).click();
  await page.getByRole("link", { name: /CRONK-1 Make it so/ }).click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Make it so" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "CRONK Cronker" })).toHaveAttribute("aria-current", "page");
  await expect(sidebar.locator("[aria-current=page]")).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar.getByRole("link", { name: /^Inbox/ })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Documents" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "CRONK Cronker" })).toBeHidden();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toBeHidden();

  await sidebar.getByRole("button", { name: "Menu" }).click();
  await expect(sidebar.getByRole("link", { name: "CRONK Cronker" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toBeVisible();
  await sidebar.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toBeHidden();
});

test("a page that isn't there marks no sidebar item", async ({ page, cronk }) => {
  await setUp(cronk);
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await sidebar.getByRole("link", { name: "Agents" }).click();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toHaveAttribute("aria-current", "page");

  // Followed without a reload, as an old link inside Cronk would be.
  await page.evaluate(() => {
    window.history.pushState(null, "", "/nowhere");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page.getByText("Nothing is here.")).toBeVisible();
  await expect(sidebar.locator("[aria-current=page]")).toHaveCount(0);
});
