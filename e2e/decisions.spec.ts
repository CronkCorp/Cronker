import { firstUser, setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("the register filters by status and points a superseded Decision at its replacement, whose page and the replaced one's say so", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const record = async (title: string, status?: string) =>
    (await (await cronk.request("POST", `/api/workspaces/${workspace.id}/decisions`, { cookie, body: { title, status } })).json()) as { id: string };
  await record("Use Postgres for everything", "accepted");
  const replaced = await record("Runs start from a Brief");
  const replacing = await record("Runs start from a Brief and the Ticket", "accepted");
  await cronk.request("PATCH", `/api/decisions/${replaced.id}`, { cookie, body: { baseVersion: 1, status: "superseded", supersededById: replacing.id } });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(firstUser.email);
  await page.getByLabel("Password").fill(firstUser.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Decisions" }).click();

  const filters = page.getByRole("group", { name: "Filter by status" });
  await expect(filters.getByRole("button")).toHaveText(["All 3", "Proposed 0", "Accepted 2", "Rejected 0", "Deprecated 0", "Superseded 1"]);
  const register = page.getByRole("region", { name: "Decisions" });
  await expect(register.getByRole("row", { name: /0002/ })).toContainText("Runs start from a Brief → 0003");
  await filters.getByRole("button", { name: "Superseded 1" }).click();
  await expect(register.getByRole("row")).toHaveCount(2);

  await register.getByRole("link", { name: "Runs start from a Brief", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runs start from a Brief", level: 1 })).toBeVisible();
  await expect(page.getByRole("note", { name: "Superseded" })).toContainText("Superseded by 0003 Runs start from a Brief and the Ticket.");
  const details = page.getByRole("complementary", { name: "Decision details" });
  await expect(details).toContainText("Proposed by");
  await expect(details).toContainText(firstUser.email);
  await page.getByRole("button", { name: "More of this Decision" }).click();
  await page.getByRole("menuitem", { name: "Supersede…" }).click();
  await expect(page.getByRole("dialog").getByLabel("Replaced by")).toHaveValue(replacing.id);
  await page.keyboard.press("Escape");

  await page.getByRole("note", { name: "Superseded" }).getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Runs start from a Brief and the Ticket", level: 1 })).toBeVisible();
  await expect(page.getByRole("note", { name: "Supersedes" })).toContainText("Supersedes 0002 Runs start from a Brief.");
});

test("a User accepts a proposed Decision from its page, and its status shows at once", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const proposed = (await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/decisions`, { cookie, body: { title: "Runs start from a Brief" } })
  ).json()) as { id: string };

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/decisions/${proposed.id}`);
  await expect(page.getByRole("heading", { name: "Runs start from a Brief", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Change status")).toHaveCount(0);

  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Accepted." })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Decision details" })).toContainText("Accepted");
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);
  const saved = (await (await cronk.request("GET", `/api/decisions/${proposed.id}`, { cookie })).json()) as { status: string };
  expect(saved.status).toBe("accepted");
});

test("rejecting a proposed Decision from its page asks first, naming it, and it stays in the register", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const proposed = (await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/decisions`, { cookie, body: { title: "Ship a desktop app" } })
  ).json()) as { id: string };

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/decisions/${proposed.id}`);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Reject 0001 Ship a desktop app?" });
  await expect(dialog).toContainText("never deleted");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("complementary", { name: "Decision details" })).toContainText("Proposed");

  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await dialog.getByRole("button", { name: "Reject" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "Rejected." })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Decision details" })).toContainText("Rejected");

  await page.getByRole("link", { name: "Decisions" }).first().click();
  await expect(page.getByRole("region", { name: "Decisions" }).getByRole("row", { name: /0001/ })).toContainText("Rejected");
});

test("a User accepts and rejects proposed Decisions in place in the register", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const record = (title: string, status?: string) =>
    cronk.request("POST", `/api/workspaces/${workspace.id}/decisions`, { cookie, body: { title, status } });
  await record("Use Postgres for everything", "accepted");
  const attachmentsOnDisk = (await (await record("Keep Attachments on disk")).json()) as { id: string };
  await record("Ship a desktop app");

  await signInInBrowser(page, cronk);
  // The same Decision open on another page follows what the register saves.
  const elsewhere = await page.context().newPage();
  await elsewhere.goto(`${cronk.url}/decisions/${attachmentsOnDisk.id}`);
  await expect(elsewhere.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Decisions" }).click();
  const register = page.getByRole("region", { name: "Decisions" });
  await expect(register.getByRole("row", { name: /0001/ }).getByRole("button")).toHaveCount(0);

  const desktop = register.getByRole("row", { name: /0003/ });
  await desktop.getByRole("button", { name: "Reject" }).click();
  const dialog = page.getByRole("dialog", { name: "Reject 0003 Ship a desktop app?" });
  await dialog.getByRole("button", { name: "Reject" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(desktop).toContainText("Rejected");
  await expect(desktop.getByRole("button")).toHaveCount(0);

  const attachments = register.getByRole("row", { name: /0002/ });
  await attachments.getByRole("button", { name: "Accept" }).click();
  await expect(attachments).toContainText("Accepted");
  await expect(attachments.getByRole("button")).toHaveCount(0);
  await expect(elsewhere.getByRole("complementary", { name: "Decision details" })).toContainText("Accepted");
  await expect(elsewhere.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Filter by status" }).getByRole("button")).toHaveText([
    "All 3",
    "Proposed 0",
    "Accepted 2",
    "Rejected 1",
    "Deprecated 0",
    "Superseded 0",
  ]);
});

test("an accepted Decision is deprecated, superseded or put back to proposed from its \"…\" menu", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const record = async (title: string, status?: string) =>
    (await (await cronk.request("POST", `/api/workspaces/${workspace.id}/decisions`, { cookie, body: { title, status } })).json()) as { id: string };
  const brief = await record("Runs start from a Brief", "accepted");
  await record("Runs start from a Brief and the Ticket", "accepted");

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/decisions/${brief.id}`);
  await expect(page.getByRole("heading", { name: "Runs start from a Brief", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
  const more = page.getByRole("button", { name: "More of this Decision" });
  const details = page.getByRole("complementary", { name: "Decision details" });

  await more.click();
  await expect(page.getByRole("menuitem")).toHaveText(["Deprecate", "Supersede…"]);
  await page.getByRole("menuitem", { name: "Deprecate" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Deprecated." })).toBeVisible();
  await expect(details).toContainText("Deprecated");

  await more.click();
  await expect(page.getByRole("menuitem")).toHaveText(["Back to proposed"]);
  await page.getByRole("menuitem", { name: "Back to proposed" }).click();
  await expect(details).toContainText("Proposed");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(details).toContainText("Accepted");

  await more.click();
  await page.getByRole("menuitem", { name: "Supersede…" }).click();
  const dialog = page.getByRole("dialog", { name: "Supersede 0001 Runs start from a Brief" });
  await dialog.getByLabel("Replaced by").selectOption({ label: "0002 Runs start from a Brief and the Ticket" });
  await dialog.getByRole("button", { name: "Supersede" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("note", { name: "Superseded" })).toContainText("Superseded by 0002 Runs start from a Brief and the Ticket.");
  await expect(details).toContainText("Superseded");
});

test("a status change from an outdated Version is refused, then the page or register shows the Decision as it stands", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const record = async (title: string) =>
    (await (await cronk.request("POST", `/api/workspaces/${workspace.id}/decisions`, { cookie, body: { title } })).json()) as { id: string };
  const brief = await record("Runs start from a Brief");
  const desktop = await record("Ship a desktop app");
  // Away from the stream, the browser misses what is saved meanwhile.
  await page.route("**/api/workspaces/*/events", (route) => route.abort());

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/decisions/${brief.id}`);
  await expect(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  await cronk.request("PATCH", `/api/decisions/${brief.id}`, { cookie, body: { baseVersion: 1, status: "accepted" } });
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("It now shows the current Version: check it, then change the status again.");
  await expect(page.getByRole("complementary", { name: "Decision details" })).toContainText("Accepted");
  await expect(page.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);

  await page.goto(`${cronk.url}/workspaces/${workspace.id}/decisions`);
  const row = page.getByRole("region", { name: "Decisions" }).getByRole("row", { name: /0002/ });
  await expect(row.getByRole("button", { name: "Accept" })).toBeVisible();
  await cronk.request("PATCH", `/api/decisions/${desktop.id}`, { cookie, body: { baseVersion: 1, status: "rejected" } });
  await row.getByRole("button", { name: "Accept" }).click();
  await expect(row.getByRole("alert")).toContainText("The register now shows it as it stands");
  await expect(row).toContainText("Rejected");
  await expect(row.getByRole("button")).toHaveCount(0);
  const saved = (await (await cronk.request("GET", `/api/decisions/${desktop.id}`, { cookie })).json()) as { status: string };
  expect(saved.status).toBe("rejected");
});
