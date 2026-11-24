import { setUp, signIn } from "../test/harness/flows.js";
import { expect, test } from "./fixtures.js";

test("the sidebar holds the main links, Tickets among them, and at phone width becomes a strip with the rest in a menu", async ({
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
  // `/` opens the active Project's board.
  await expect(page.getByRole("heading", { name: "Cronker", level: 1 })).toBeVisible();
  const tickets = sidebar.getByRole("link", { name: "Tickets" });
  await expect(sidebar.locator(".sidebar-strip").getByRole("link")).toHaveText([/^Inbox/, "Tickets", "Documents", "Terms", "Decisions", "Artifacts"]);
  await expect(sidebar.getByRole("link", { name: "Agents" })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Menu" })).toBeHidden();

  // Exactly one active item: Tickets, on the board and on a Ticket.
  await expect(tickets).toHaveAttribute("aria-current", "page");
  await page.getByRole("link", { name: /CRONK-1 Make it so/ }).click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Make it so" })).toBeVisible();
  await expect(tickets).toHaveAttribute("aria-current", "page");
  await expect(sidebar.locator("[aria-current=page]")).toHaveCount(1);

  // At phone width the strip keeps the main links, Tickets included, and the Menu holds the rest.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar.getByRole("link", { name: /^Inbox/ })).toBeVisible();
  await expect(tickets).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Documents" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toBeHidden();

  await sidebar.getByRole("button", { name: "Menu" }).click();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toBeVisible();
  await sidebar.getByRole("link", { name: "Agents" }).click();
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Agents" })).toBeHidden();

  await tickets.click();
  await expect(page.getByRole("heading", { name: "Cronker", level: 1 })).toBeVisible();
});

test("the selector shows the Workspace and the active Project, switches Project and Workspace, and lists Archived in a submenu", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = async (name: string, key: string) =>
    (await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name, key } })).json();
  await project("Website", "WEB");
  await project("Cronker", "CRONK");
  const old = await project("Old things", "OLD");
  await cronk.request("POST", `/api/projects/${old.id}/archive`, { cookie });
  await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Friends" } });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });

  // With none remembered, the first unarchived Project by key.
  const selector = sidebar.getByRole("button", { name: "Workspace and Project: Ada's Workspace, CRONK Cronker" });
  await expect(selector).toBeVisible();
  await expect(selector).toContainText("Ada's Workspace");
  await expect(selector).toContainText("CRONK Cronker");

  await selector.click();
  const projects = page.getByRole("group", { name: "Projects" });
  await expect(projects.getByRole("menuitemradio")).toHaveText(["CRONK Cronker", "WEB Website"]);
  await expect(projects.getByRole("menuitemradio", { name: "CRONK Cronker" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: "WEB Website" }).click();
  await expect(page.getByRole("heading", { name: "Website", level: 1 })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Workspace and Project: Ada's Workspace, WEB Website" })).toBeVisible();

  // Archived Projects sit in a submenu.
  await sidebar.getByRole("button", { name: /^Workspace and Project/ }).click();
  await expect(page.getByRole("menuitemradio", { name: "OLD Old things" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Archived" }).click();
  await page.getByRole("menuitemradio", { name: "OLD Old things" }).click();
  await expect(page.getByRole("heading", { name: "Old things", level: 1 })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Workspace and Project: Ada's Workspace, OLD Old things" })).toBeVisible();

  // New Project… leads to the Projects overview's form.
  await sidebar.getByRole("button", { name: /^Workspace and Project/ }).click();
  await page.getByRole("menuitem", { name: "New Project…" }).click();
  await expect(page.getByLabel("Project name")).toBeFocused();

  // Another Workspace, the current one checked.
  await sidebar.getByRole("button", { name: /^Workspace and Project/ }).click();
  const workspaces = page.getByRole("group", { name: "Workspaces" });
  await expect(workspaces.getByRole("menuitemradio", { name: "Ada's Workspace" })).toHaveAttribute("aria-checked", "true");
  await workspaces.getByRole("menuitemradio", { name: "Friends" }).click();
  // Friends has no Project: it opens its Projects overview, and Tickets is hidden.
  await expect(page.getByRole("heading", { name: "Friends", level: 1 })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Workspace and Project: Friends" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Tickets" })).toHaveCount(0);
  await expect(sidebar.getByRole("link", { name: "Documents" })).toBeVisible();

  // Back in Ada's Workspace, its active Project's board opens.
  await sidebar.getByRole("button", { name: /^Workspace and Project/ }).click();
  await page.getByRole("group", { name: "Workspaces" }).getByRole("menuitemradio", { name: "Ada's Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Old things", level: 1 })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Tickets" })).toHaveAttribute("aria-current", "page");
});

test("the active Project is remembered across a Workspace page, and `/` opens its board", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  for (const [name, key] of [["Cronker", "CRONK"], ["Website", "WEB"]]) {
    await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name, key } });
  }

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await expect(page.getByRole("heading", { name: "Cronker", level: 1 })).toBeVisible();
  await sidebar.getByRole("button", { name: /^Workspace and Project/ }).click();
  await page.getByRole("menuitemradio", { name: "WEB Website" }).click();
  await expect(page.getByRole("heading", { name: "Website", level: 1 })).toBeVisible();

  await sidebar.getByRole("link", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: "Workspace and Project: Ada's Workspace, WEB Website" })).toBeVisible();

  // And across a reload, kept on this browser.
  await page.reload();
  await expect(sidebar.getByRole("button", { name: "Workspace and Project: Ada's Workspace, WEB Website" })).toBeVisible();

  // `/` opens the remembered Project's board.
  await page.goto(cronk.url);
  await expect(page.getByRole("heading", { name: "Website", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/WEB$/);
});
