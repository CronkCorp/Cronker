import { fileURLToPath } from "node:url";
import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { firstUser } from "../test/harness/flows.js";
import { startCronk, type StartedCronk } from "../test/harness/start-cronk.js";

export const webRoot = fileURLToPath(new URL("../dist/web/", import.meta.url));

export const test = base.extend<{ cronk: StartedCronk }>({
  cronk: async ({}, use) => {
    const cronk = await startCronk({ webRoot });
    await use(cronk);
    await cronk.stop();
  },
});

export { expect } from "@playwright/test";

/** A Ticket field's in-place picker, named by its label and current value, such as "Status Backlog". */
export const fieldPicker = (page: Page, label: string) => page.getByRole("button", { name: new RegExp(`^${label} `) });

/** Picks a value of a Ticket field in place, as a User clicks its value and then an option. */
export async function pick(page: Page, label: string, option: string) {
  await fieldPicker(page, label).click();
  await page.getByRole("listbox", { name: label }).getByRole("option", { name: option, exact: true }).click();
}

/** Creates a Ticket from the Project's page head, as New Ticket does. */
export async function newTicket(page: Page, title: string) {
  await page.getByRole("button", { name: "New Ticket" }).click();
  await page.getByRole("dialog").getByLabel("Title").fill(title);
  await page.getByRole("dialog").getByRole("button", { name: "Create Ticket" }).click();
}

/** Opens the Project's settings from its page head's "…" menu. */
export async function openProjectSettings(page: Page) {
  await page.getByRole("button", { name: "More of this Project" }).click();
  await page.getByRole("menuitem", { name: "Project settings" }).click();
}

/** How wide something is drawn, to tell a button that fits its label from one that spans its card. */
export async function widthOf(locator: Locator) {
  return (await locator.boundingBox())!.width;
}

/** Signs the first User in through the sign-in page, as `setUp` made them, and waits for the frame. */
export async function signInInBrowser(page: Page, cronk: StartedCronk) {
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(firstUser.email);
  await page.getByLabel("Password").fill(firstUser.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
}
