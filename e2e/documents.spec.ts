import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";

const ada = { email: "ada@example.com", password: "correct horse battery" };

/** Sets Cronk up with Ada and Bea in one Workspace, signs Ada in, and opens a Workspace Document Ada wrote. */
async function openDocument(page: Page, cronk: StartedCronk, body: string) {
  const setup = await cronk.request("POST", "/api/setup", {
    body: { ...ada, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" },
  });
  const { workspace } = await setup.json();
  const signIn = async (email: string, password: string) =>
    (await cronk.request("POST", "/api/sign-in", { body: { email, password } })).headers.get("set-cookie")!.split(";")[0]!;
  const adaCookie = await signIn(ada.email, ada.password);
  const added = await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie: adaCookie, body: { email: "bea@example.com" } });
  const { link } = await added.json();
  await cronk.request("POST", "/api/links/use", { body: { token: new URL(link.url).hash.slice(1), password: "bea's password" } });
  const beaCookie = await signIn("bea@example.com", "bea's password");
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/documents`, {
    cookie: adaCookie,
    body: { title: "How Runs start", body },
  });
  const document = await created.json();

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(ada.email);
  await page.getByLabel("Password").fill(ada.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
  await page.goto(`${cronk.url}/documents/${document.id}`);
  await expect(page.getByRole("heading", { name: "How Runs start" })).toBeVisible();
  /** Bea saves the Document on top of the Version she names. */
  const beaSaves = (baseVersion: number, body: string) =>
    cronk.request("PATCH", `/api/documents/${document.id}`, { cookie: beaCookie, body: { baseVersion, body } });
  return { document, beaSaves };
}

test("a refused save keeps the draft under a banner naming who saved which Version, with a Diff of their changes", async ({ page, cronk }) => {
  const { beaSaves } = await openDocument(page, cronk, "Runs start from a Brief.");
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("button", { name: "Save as Version 2" })).toBeVisible();
  await page.getByLabel("Markdown").fill("Runs start from a Brief.\nAda's line.");

  // Meanwhile Bea saves Version 2, so Ada's save on Version 1 is refused.
  expect((await beaSaves(1, "Runs start from a Brief.\nBea's line.")).status).toBe(200);
  await page.getByRole("button", { name: "Save as Version 2" }).click();

  const banner = page.getByRole("note", { name: "Saved meanwhile" });
  await expect(banner).toContainText("bea@example.com saved Version 2");
  const theirChanges = banner.getByRole("region", { name: "Their changes" });
  await expect(theirChanges.getByRole("deletion")).toHaveText("Ada's line.");
  await expect(theirChanges.getByRole("insertion")).toHaveText("Bea's line.");
  await expect(page.getByLabel("Markdown")).toHaveValue("Runs start from a Brief.\nAda's line.");
  // Version 2 is Bea's now, so no button offers to save as Version 2 again.
  await expect(page.getByRole("button", { name: "Save as Version 2" })).toHaveCount(0);

  // Ada folds Bea's line in, bases her draft on Version 2, and saves Version 3.
  await page.getByLabel("Markdown").fill("Runs start from a Brief.\nBea's line.\nAda's line.");
  await banner.getByRole("button", { name: "Base my draft on Version 2" }).click();
  await expect(banner).toHaveCount(0);
  await page.getByRole("button", { name: "Save as Version 3" }).click();
  await expect(page.getByRole("article", { name: "How Runs start" })).toContainText("Bea's line. Ada's line.");
  await expect(page.getByRole("region", { name: "Versions" }).getByRole("listitem")).toHaveCount(3);
});
