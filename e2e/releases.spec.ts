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
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
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
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
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
