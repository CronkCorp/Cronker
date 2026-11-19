import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, fieldPicker, newTicket, pick, test } from "./fixtures.js";

async function signedInWithTickets(page: Page, cronk: StartedCronk, titles: string[]) {
  const setup = await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  expect(setup.status).toBe(201);
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Project name").fill("Cronker");
  await page.getByLabel("Key").fill("CRONK");
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByRole("heading", { name: "Cronker" })).toBeVisible();
  for (const [i, title] of titles.entries()) {
    await newTicket(page, title);
    await expect(page.getByRole("link", { name: `CRONK-${i + 1} ${title}` })).toBeVisible();
  }
}

test("relate Tickets, make a Sub-Ticket, and see both sides on the Ticket view and timeline", async ({
  page,
  cronk,
}) => {
  await signedInWithTickets(page, cronk, ["Sign in", "Relations", "Run queue", "Board", "Ticket view"]);

  await page.getByRole("link", { name: "CRONK-2 Relations" }).click();
  await expect(page.getByRole("heading", { name: "CRONK-2 Relations" })).toBeVisible();
  const relations = page.getByRole("region", { name: "Relations" });
  const group = (name: string) => relations.getByRole("list", { name, exact: true });

  const add = async (kind: string, key: string) => {
    await pick(page, "Relation", kind);
    await expect(fieldPicker(page, "Relation")).toHaveAccessibleName(`Relation ${kind}`);
    await relations.getByLabel("Ticket", { exact: true }).fill(key);
    await relations.getByRole("button", { name: "Add" }).click();
  };
  await add("Blocked by", "CRONK-1");
  await expect(group("Blocked by")).toContainText("CRONK-1 Sign in");
  await add("Blocks", "cronk-3");
  await expect(group("Blocks")).toContainText("CRONK-3 Run queue");
  await add("Relates to", "CRONK-4");
  await expect(group("Relates to")).toContainText("CRONK-4 Board");

  // A block the other way would close a cycle.
  await add("Blocked by", "CRONK-3");
  await expect(relations.getByRole("alert")).toContainText("cycle");

  await group("Relates to").getByRole("button", { name: "Remove" }).click();
  await expect(group("Relates to")).toHaveCount(0);

  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline).toContainText("ada@example.com marked this blocked by CRONK-1 Sign in");
  await expect(timeline).toContainText("ada@example.com marked this as blocking CRONK-3 Run queue");
  await expect(timeline).toContainText("ada@example.com removed the relation to CRONK-4 Board");

  await relations.getByRole("link", { name: "CRONK-1 Sign in" }).click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Sign in" })).toBeVisible();
  await expect(group("Blocks")).toContainText("CRONK-2 Relations");

  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await page.getByRole("link", { name: "CRONK-5 Ticket view" }).click();
  await pick(page, "Parent", "CRONK-2 Relations");
  await expect(relations.getByRole("link", { name: "CRONK-2 Relations" })).toBeVisible();
  await expect(timeline).toContainText("ada@example.com changed Parent from none to CRONK-2 Relations");

  await relations.getByRole("link", { name: "CRONK-2 Relations" }).click();
  await expect(page.getByRole("heading", { name: "CRONK-2 Relations" })).toBeVisible();
  await expect(group("Sub-Tickets")).toContainText("CRONK-5 Ticket view");
  await expect(timeline).toContainText("ada@example.com added Sub-Ticket CRONK-5 Ticket view");
});
