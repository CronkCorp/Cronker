import type { Page } from "@playwright/test";
import { addMember, setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** Signs the page in as another User, as they would at the sign-in page. */
async function signInAs(page: Page, url: string, email: string, password: string) {
  await page.context().clearCookies();
  await page.goto(url);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeVisible();
}

test("an Admin makes a Project private and lists a User with Read, who sees its board without New Ticket or dragging, and no editor", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const adaCookie = await signIn(cronk);
  const grace = await addMember(cronk, adaCookie, workspace.id, "grace@example.com");
  const linus = await addMember(cronk, adaCookie, workspace.id, "linus@example.com");
  const post = async (path: string, body: unknown) =>
    (await cronk.request("POST", path, { cookie: adaCookie, body })).json() as Promise<{ id: string }>;
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await post(`/api/projects/${project.id}/tickets`, { title: "Read access", description: "Readers **follow** the work." });
  const document = await post(`/api/projects/${project.id}/documents`, { title: "Plan", body: "Runs start from a **Brief**." });

  // Ada, the Admin, makes CRONK private and lists Grace on it with Read.
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);
  const access = page.getByRole("region", { name: "Access" });
  await access.getByLabel("Private to the Users listed below").click();
  await expect(access.getByLabel("Private to the Users listed below")).toBeChecked();
  await access.getByLabel(/^grace@example\.com/).click();
  await expect(access.getByLabel("Access of grace@example.com")).toHaveValue("write");
  await access.getByLabel("Access of grace@example.com").selectOption("Read");
  await expect(access.getByRole("status")).toHaveText("Saved.");
  await expect(access.getByLabel("Access of grace@example.com")).toHaveValue("read");
  // Ada lets Agents only read CRONK: nothing is delegated, so it saves at once.
  await access.getByLabel("Agent Access", { exact: true }).selectOption("read");
  await expect(access.getByLabel("Agent Access", { exact: true })).toHaveValue("read");

  // Ada, with Write, still edits the Document in the rich editor.
  await page.goto(`${cronk.url}/documents/${document.id}`);
  await page.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("textbox", { name: "Body" })).toBeVisible();
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toBeVisible();

  // Grace sees the board and its card, but no New Ticket, and the card doesn't drag or offer changes.
  await signInAs(page, cronk.url, "grace@example.com", grace.password);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /CRONK/ }).click();
  await expect(page.getByRole("heading", { name: "Cronker" })).toBeVisible();
  await expect(page.getByRole("note")).toHaveText("You have Read in this Project: you follow its work, but don't change it.");
  const board = page.getByRole("region", { name: "Board" });
  const card = board.getByRole("link", { name: /CRONK-1 Read access/ });
  await expect(card).toBeVisible();
  await expect(page.getByRole("button", { name: "New Ticket" })).toHaveCount(0);
  await expect(board.locator(".card")).toHaveAttribute("draggable", "false");

  const from = (await card.boundingBox())!;
  const to = (await board.getByRole("region", { name: "Triage" }).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + 160, { steps: 8 });
  await page.mouse.up();
  await expect(board.getByRole("region", { name: "Backlog" }).getByRole("link", { name: /CRONK-1/ })).toBeVisible();
  await expect(board.getByRole("region", { name: "Triage" }).getByRole("link", { name: /CRONK-1/ })).toHaveCount(0);
  await card.click({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Her Ticket page reads as anyone's, without the Comment box or Edit.
  await card.click();
  await expect(page.getByRole("heading", { name: /Read access/ })).toBeVisible();
  await expect(page.getByLabel("New Comment")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Description" }).getByText("follow")).toBeVisible();
  await expect(page.locator("[contenteditable=true]")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);

  // The Project's Document reads as rendered text, with no Edit and no editor.
  await page.goto(`${cronk.url}/documents/${document.id}`);
  await expect(page.getByRole("heading", { name: "Plan" })).toBeVisible();
  await expect(page.getByRole("note")).toHaveText("You have Read in this Project: you follow its work, but don't change it.");
  await expect(page.getByText("Brief", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(page.locator("[contenteditable=true]")).toHaveCount(0);
  await expect(page.getByRole("toolbar", { name: "Formatting" })).toHaveCount(0);

  // Linus, unlisted, doesn't see the Project at all.
  await signInAs(page, cronk.url, "linus@example.com", linus.password);
  await expect(page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: /CRONK/ })).toHaveCount(0);
  await page.goto(`${cronk.url}/projects/${project.id}`);
  await expect(page.getByText("Nothing is here.")).toBeVisible();
});

test("an Access change that takes a User's Write from their Tickets names how many first", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const adaCookie = await signIn(cronk);
  const grace = await addMember(cronk, adaCookie, workspace.id, "grace@example.com");
  const request = async (method: string, path: string, body: unknown) =>
    (await cronk.request(method, path, { cookie: adaCookie, body })).json() as Promise<{ id: string }>;
  const project = await request("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await request("POST", `/api/projects/${project.id}/tickets`, { title: "Grace's work" });
  await request("PATCH", `/api/tickets/${ticket.id}`, { assigneeId: grace.user.id });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);
  const access = page.getByRole("region", { name: "Access" });
  await access.getByLabel("Private to the Users listed below").click();
  const dialog = page.getByRole("dialog", { name: "Change Access?" });
  await expect(dialog).toContainText("1 Ticket will be unassigned or undelegated");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(access.getByLabel("Open to every User of the Workspace")).toBeChecked();

  await access.getByLabel("Private to the Users listed below").click();
  await dialog.getByRole("button", { name: "Change Access" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(access.getByLabel("Private to the Users listed below")).toBeChecked();
  const after = await cronk.request("GET", `/api/tickets/${ticket.id}`, { cookie: adaCookie });
  expect(await after.json()).toMatchObject({ assigneeId: null });
});
