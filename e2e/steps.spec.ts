import { expect, test } from "./fixtures.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import type { Page } from "@playwright/test";

/** Ada signed in, on the settings of a new Project with one Ticket in Triage. */
async function projectSettings(page: Page, cronk: StartedCronk) {
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
  const project = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } })
  ).json();
  const ticket = await (
    await cronk.request("POST", `/api/projects/${project.id}/tickets`, { cookie, body: { title: "Make it so" } })
  ).json();
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { statusId: triage } });

  await page.goto(`${cronk.url}/projects/${project.id}/settings`);
  await expect(page.getByRole("heading", { name: "Steps" })).toBeVisible();
}

test("attach, edit and remove Steps in Project settings, and preview a Ticket's Brief", async ({ page, cronk }) => {
  await projectSettings(page, cronk);
  const steps = page.getByRole("region", { name: "Steps" });
  const open = (status: string) => steps.locator("summary strong", { hasText: new RegExp(`^${status}$`) }).click();

  await expect(steps.getByText("haiku, 2 Outcomes")).toBeVisible();
  await expect(steps.getByText("No Step: Tickets here wait for a person")).toHaveCount(5);

  await open("Ready");
  await steps.getByRole("button", { name: "Add a Step to Ready" }).click();
  await steps.getByLabel("Brief for Ready").fill("Plan the work.");
  await steps.getByLabel("Model for Ready").fill("opus");
  await steps.getByLabel("Status needs you of Ready moves to").selectOption("Done");
  await steps.getByRole("button", { name: "Save the Step on Ready" }).click();
  await expect(steps.getByRole("alert")).toContainText("asking a person must never complete work");

  await steps.getByLabel("Status needs you of Ready moves to").selectOption("Backlog");
  await steps.getByRole("button", { name: "Save the Step on Ready" }).click();
  await expect(steps.getByText("opus, 2 Outcomes")).toBeVisible();

  await open("Investigate");
  await steps.getByLabel("Model for Investigate").fill("opus");
  await steps.getByRole("button", { name: "Save the Step on Investigate" }).click();
  await expect(steps.getByText("opus, 2 Outcomes")).toHaveCount(2);
  await steps.getByRole("button", { name: "Remove the Step from Investigate" }).click();
  await expect(steps.getByText("No Step: Tickets here wait for a person")).toHaveCount(5);

  const preview = page.getByRole("region", { name: "Brief preview" });
  await preview.getByLabel("Ticket key").fill("cronk-1");
  await preview.getByRole("button", { name: "Preview Brief" }).click();
  const brief = preview.getByLabel("Brief for CRONK-1");
  await expect(brief.getByRole("heading", { name: "Cronk's preamble" })).toBeVisible();
  await expect(brief).toContainText("as one Run of its Triage Step");
  await expect(brief).toContainText("Triage this Ticket");
  await expect(brief.locator("pre").last()).toHaveText("CRONK-1");
});
