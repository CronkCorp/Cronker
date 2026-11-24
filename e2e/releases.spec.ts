import { addMember, createGitHubApp, setUp, signIn } from "../test/harness/flows.js";
import { branchesOf } from "../test/harness/github.js";
import { expect, fieldPicker, pick, signInInBrowser, test } from "./fixtures.js";

/**
 * Releases (CRONK-114): a Project's Releases page, the Release field on a Ticket and the Release chip on board cards,
 * each showing what another member changes without a reload.
 */
test("the Releases page, a Ticket's Release field and its card's chip follow live updates", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
    cookie,
    body: { name: "Cronker", key: "CRONK" },
  });
  const project = (await created.json()) as { id: string; statuses: { id: string; name: string }[] };
  const bob = await addMember(cronk, cookie, workspace.id, "bob@example.com");
  const asBob = (method: string, path: string, body?: unknown) =>
    cronk.request(method, path, { cookie: bob.cookie, body }).then(async (response) => {
      expect(response.ok).toBe(true);
      return response.status === 204 ? null : response.json();
    });
  const ticket = await asBob("POST", `/api/projects/${project.id}/tickets`, { title: "Ship it" });

  await signInInBrowser(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  await page.getByRole("button", { name: "More of this Project" }).click();
  await page.getByRole("menuitem", { name: "Releases" }).click();
  await expect(page.getByRole("heading", { name: "Releases", level: 1 })).toBeVisible();
  await expect(page.getByText("No Releases yet.")).toBeVisible();

  // Ada creates one; a name that isn't a semantic version is refused in the dialog.
  await page.getByRole("button", { name: "New Release" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill("next");
  await dialog.getByRole("button", { name: "Create Release" }).click();
  await expect(dialog).toContainText("isn't a semantic version");
  await dialog.getByLabel("Name").fill("v0.3.0");
  await dialog.getByRole("button", { name: "Create Release" }).click();
  const release = page.getByRole("region", { name: "Release v0.3.0" });
  await expect(release).toContainText("Planned");
  await expect(release).toContainText("release/v0.3.0");
  await expect(release).toContainText("0 open · 0 done");

  // Bob tags the Ticket and creates another Release: the page shows both without a reload.
  await asBob("PATCH", `/api/tickets/${ticket.id}`, { release: "v0.3.0" });
  await expect(release.getByRole("link", { name: /CRONK-1 Ship it/ })).toBeVisible();
  await expect(release).toContainText("1 open · 0 done");
  await asBob("POST", `/api/projects/${project.id}/releases`, { name: "v0.4.0" });
  await expect(page.getByRole("region", { name: "Release v0.4.0" })).toBeVisible();

  // The board's card shows the Release chip, and follows Bob moving the Ticket to another Release.
  await page.getByRole("link", { name: "CRONK", exact: true }).click();
  const card = page.getByRole("region", { name: "Board" }).getByRole("link", { name: /CRONK-1 Ship it/ });
  await expect(card).toContainText("v0.3.0");
  await asBob("PATCH", `/api/tickets/${ticket.id}`, { release: "v0.4.0" });
  await expect(card).toContainText("v0.4.0");
  await expect(card).not.toContainText("v0.3.0");

  // On the Ticket, the Release field picks among the planned Releases and follows Bob's changes.
  await card.click();
  await expect(fieldPicker(page, "Release")).toContainText("v0.4.0");
  await pick(page, "Release", "v0.3.0");
  await expect(fieldPicker(page, "Release")).toContainText("v0.3.0");
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText("changed Release from v0.4.0 to v0.3.0");
  await asBob("PATCH", `/api/tickets/${ticket.id}`, { release: null });
  await expect(fieldPicker(page, "Release")).toContainText("None");
});

/** Cutting a Release (CRONK-115) from the Releases page: the dialog lists the Repositories, then the cut commits show. */
test("Cut creates the release branches and shows each Repository's commit", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const installation = cronk.github.install(cronk.github.apps[0]!, "cronkcorp", ["cronker", "website"]);
  const asAda = (method: string, path: string, body?: unknown) =>
    cronk.request(method, path, { cookie, body }).then(async (response) => {
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json();
    });
  const project = await asAda("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  for (const repository of installation.repositories) {
    await asAda("POST", `/api/projects/${project.id}/repositories`, { id: repository.id });
  }
  await asAda("POST", `/api/projects/${project.id}/releases`, { name: "v0.3.0" });
  const [cronker, website] = installation.repositories.map((r) => branchesOf(r).get("main")!);

  await signInInBrowser(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  await page.getByRole("button", { name: "More of this Project" }).click();
  await page.getByRole("menuitem", { name: "Releases" }).click();
  const release = page.getByRole("region", { name: "Release v0.3.0" });
  await release.getByRole("button", { name: "Cut…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("cronkcorp/cronker and cronkcorp/website");
  await dialog.getByRole("button", { name: "Cut" }).click();

  await expect(release.getByText(/^Cut by /)).toBeVisible();
  const commits = release.getByRole("list", { name: "Commits v0.3.0 was cut at" });
  await expect(commits).toContainText(`cronkcorp/cronker ${cronker!.slice(0, 7)}`);
  await expect(commits).toContainText(`cronkcorp/website ${website!.slice(0, 7)}`);
  await expect(release.getByRole("button", { name: "Cut…" })).toHaveCount(0);
  await expect(release.getByRole("button", { name: "More of v0.3.0" })).toHaveCount(0);
  expect(cronk.github.refsCreated.map((r) => r.repository)).toEqual(["cronkcorp/cronker", "cronkcorp/website"]);
});

/**
 * Releasing a Release (CRONK-118): the dialog takes Upgrade notes, lists the open Tickets on the first try and offers
 * Release anyway, then the released Release shows each Repository's GitHub Release.
 */
test("Release lists open Tickets, goes ahead when confirmed and links each GitHub Release", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const installation = cronk.github.install(cronk.github.apps[0]!, "cronkcorp", ["cronker", "website"]);
  const asAda = (method: string, path: string, body?: unknown) =>
    cronk.request(method, path, { cookie, body }).then(async (response) => {
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json();
    });
  const project = await asAda("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  for (const repository of installation.repositories) {
    await asAda("POST", `/api/projects/${project.id}/repositories`, { id: repository.id });
  }
  const created = await asAda("POST", `/api/projects/${project.id}/releases`, { name: "v0.3.0" });
  await asAda("POST", `/api/projects/${project.id}/tickets`, { title: "Still going", release: "v0.3.0" });
  await asAda("POST", `/api/projects/${project.id}/releases/${created.id}/cut`, {});

  await signInInBrowser(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  await page.getByRole("button", { name: "More of this Project" }).click();
  await page.getByRole("menuitem", { name: "Releases" }).click();
  const release = page.getByRole("region", { name: "Release v0.3.0" });
  await release.getByRole("button", { name: "Release…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("cronkcorp/cronker, cronkcorp/website");
  await dialog.getByLabel("Upgrade notes").fill("Run the migration first.");
  await dialog.getByRole("button", { name: "Release", exact: true }).click();

  const open = dialog.getByRole("list", { name: "Open Tickets of v0.3.0" });
  await expect(open).toContainText("CRONK-1 Still going (Backlog)");
  expect(cronk.github.releasesCreated).toEqual([]);
  await dialog.getByRole("button", { name: "Release anyway" }).click();

  await expect(dialog).toHaveCount(0);
  await expect(release).toContainText("Released");
  await expect(release.getByText(/Released by /)).toBeVisible();
  for (const repository of ["cronkcorp/cronker", "cronkcorp/website"]) {
    const link = release.getByRole("link", { name: "GitHub Release v0.3.0" }).and(
      page.locator(`a[href="https://github.com/${repository}/releases/tag/v0.3.0"]`),
    );
    await expect(link).toBeVisible();
  }
  await expect(release.getByRole("button", { name: "Release…" })).toHaveCount(0);
  expect(cronk.github.releasesCreated.map((r) => r.body)).toEqual([
    "## Upgrade notes\n\nRun the migration first.\n\n## Tickets\n\n- CRONK-1: Still going\n",
    "## Upgrade notes\n\nRun the migration first.\n\n## Tickets\n\n- CRONK-1: Still going\n",
  ]);
});

/**
 * Tagging a completed Ticket (CRONK-117): the Release field of a Ticket in a Done Status also offers cut Releases; an
 * open Ticket's offers only planned ones.
 */
test("a completed Ticket's Release field offers cut Releases", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const installation = cronk.github.install(cronk.github.apps[0]!, "cronkcorp", ["cronker"]);
  const asAda = (method: string, path: string, body?: unknown) =>
    cronk.request(method, path, { cookie, body }).then(async (response) => {
      expect(response.ok, await response.clone().text()).toBe(true);
      return response.json();
    });
  const project = await asAda("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const done = project.statuses.find((s: { name: string }) => s.name === "Done").id;
  await asAda("POST", `/api/projects/${project.id}/repositories`, { id: installation.repositories[0]!.id });
  const cut = await asAda("POST", `/api/projects/${project.id}/releases`, { name: "v0.3.0" });
  await asAda("POST", `/api/projects/${project.id}/releases/${cut.id}/cut`);
  await asAda("POST", `/api/projects/${project.id}/releases`, { name: "v0.4.0" });
  await asAda("POST", `/api/projects/${project.id}/tickets`, { title: "Still open" });
  const completed = await asAda("POST", `/api/projects/${project.id}/tickets`, { title: "Already shipped" });
  await asAda("PATCH", `/api/tickets/${completed.id}`, { statusId: done });

  await signInInBrowser(page, cronk);
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Tickets" }).click();
  const board = page.getByRole("region", { name: "Board" });
  await board.getByRole("link", { name: /CRONK-1 Still open/ }).click();
  await fieldPicker(page, "Release").click();
  const offered = page.getByRole("listbox", { name: "Release" });
  await expect(offered.getByRole("option", { name: "v0.4.0", exact: true })).toBeVisible();
  await expect(offered.getByRole("option", { name: "v0.3.0", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.goBack();
  // Done starts collapsed: open it to reach the completed Ticket's card.
  await board.getByRole("button", { name: /Done/ }).first().click();
  await board.getByRole("link", { name: /CRONK-2 Already shipped/ }).click();
  // With no merged Pull Request, tagging it only tags it.
  await pick(page, "Release", "v0.3.0");
  await expect(fieldPicker(page, "Release")).toContainText("v0.3.0");
});
