import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

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

test("every page opens with breadcrumbs and its title, and a sidebar page marks its own item", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  const crumbs = page.getByRole("main").getByRole("navigation", { name: "Breadcrumbs" });

  await expect(page.getByRole("heading", { name: "Ada's Workspace", level: 1 })).toBeVisible();
  await expect(crumbs).toBeVisible();

  for (const [link, title] of [
    [/^Inbox/, "Inbox"],
    ["Documents", "Documents"],
    ["Terms", "Terms"],
    ["Decisions", "Decisions"],
    ["Artifacts", "Artifacts"],
    ["CRONK Cronker", "Cronker"],
    ["Agents", "Agents"],
    ["Runners", "Runners"],
    ["Members", "Members"],
    ["GitHub", "GitHub"],
    ["Settings", "Settings"],
  ] as const) {
    await sidebar.getByRole("link", { name: link }).click();
    await expect(page.getByRole("heading", { name: title, level: 1 })).toBeVisible();
    await expect(crumbs).toBeVisible();
    await expect(sidebar.locator("[aria-current=page]")).toHaveCount(1);
    await expect(sidebar.getByRole("link", { name: link })).toHaveAttribute("aria-current", "page");
  }

  await sidebar.getByRole("button", { name: "ada@example.com" }).click();
  await page.getByRole("menuitem", { name: "Password" }).click();
  await expect(page.getByRole("heading", { name: "Password", level: 1 })).toBeVisible();
  await expect(crumbs).toBeVisible();

  await sidebar.getByRole("button", { name: /^Workspace:/ }).click();
  await page.getByRole("menuitem", { name: "New Workspace" }).click();
  await expect(page.getByRole("heading", { name: "New Workspace", level: 1 })).toBeVisible();
  await expect(crumbs).toBeVisible();
  await expect(sidebar.locator("[aria-current=page]")).toHaveCount(0);
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

test("the sidebar hides to give the main column the window, stays hidden across reloads and pages, and shows again", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });

  await page.setViewportSize({ width: 1600, height: 900 });
  await signInInBrowser(page, cronk);
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  const hide = page.getByRole("button", { name: "Hide sidebar" });
  const show = page.getByRole("button", { name: "Show sidebar" });
  await expect(show).toBeHidden();

  await hide.click();
  await expect(sidebar).toBeHidden();
  await expect(show).toBeFocused();

  await page.reload();
  await expect(page.getByRole("heading", { name: "Ada's Workspace", level: 1 })).toBeVisible();
  await expect(sidebar).toBeHidden();
  await expect(show).toBeVisible();

  await show.click();
  await expect(sidebar).toBeVisible();
  await expect(hide).toBeFocused();
  await page.reload();
  await expect(sidebar.getByRole("link", { name: "CRONK Cronker" })).toBeVisible();
  await expect(show).toBeHidden();
});

test("with the sidebar hidden, a board spans the window, and so does every other page", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = await created.json();

  await page.setViewportSize({ width: 1600, height: 900 });
  await signInInBrowser(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const width = async () => (await board.boundingBox())!.width;
  // Beside the sidebar: 1600px less its 232px and the main column's 16px padding on each side.
  expect(await width()).toBeCloseTo(1336, 0);

  await page.getByRole("button", { name: "Hide sidebar" }).click();
  expect(await width()).toBeGreaterThan(1500);

  // Moving between pages keeps it hidden: the Workspace's page widens into the window too, and back on the board it's wide.
  await page.getByRole("main").getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "Ada's Workspace" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace", level: 1 })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Sidebar" })).toBeHidden();
  expect((await page.getByRole("heading", { name: "Ada's Workspace", level: 1 }).boundingBox())!.x).toBeLessThan(100);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/projects/${project.key}$`));
  expect(await width()).toBeGreaterThan(1500);
});

test("Ctrl+\\ toggles the sidebar, but not while typing in a field or in a dialog, and at phone width nothing hides it", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await signInInBrowser(page, cronk);
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });

  await sidebar.getByRole("link", { name: "CRONK Cronker" }).click();
  await page.getByRole("button", { name: "New Ticket" }).click();
  await page.getByRole("dialog").getByRole("heading").click();
  await page.keyboard.press("Control+\\");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(sidebar).toBeVisible();

  await page.keyboard.press("Control+\\");
  await expect(sidebar).toBeHidden();
  await page.keyboard.press("Control+\\");
  await expect(sidebar).toBeVisible();

  await sidebar.getByRole("searchbox", { name: "Search" }).focus();
  await page.keyboard.press("Control+\\");
  await expect(sidebar).toBeVisible();

  // Hidden on a wide window, the phone's strip still shows, with neither button.
  await page.getByRole("heading", { level: 1 }).click();
  await page.keyboard.press("Control+\\");
  await expect(sidebar).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sidebar.getByRole("link", { name: /^Inbox/ })).toBeVisible();
  // The Workspace's name isn't squeezed over the links beside it.
  const switcher = sidebar.getByRole("button", { name: /^Workspace:/ });
  expect(await switcher.evaluate((button) => button.scrollWidth <= button.clientWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Hide sidebar" })).toBeHidden();
  await page.keyboard.press("Control+\\");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(sidebar).toBeHidden();
});
