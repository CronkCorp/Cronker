import { expect, openProjectSettings, test } from "./fixtures.js";
import { createGitHubApp, setUp, signIn } from "../test/harness/flows.js";

test("add a Repository the App is installed on to a Project, turn Pull Request automation off, see its rename, and remove it", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  cronk.github.signedInAs = cronk.github.account("ada-gh");
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker", "website"]);
  const cronker = installation.repositories[0]!;
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = await created.json();

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await openProjectSettings(page);

  const repositories = page.getByRole("region", { name: "Repositories" });
  await expect(repositories.getByText("The Project lists no Repositories yet.")).toBeVisible();
  await repositories.getByRole("button", { name: "Add Repository" }).click();
  await page.getByRole("listbox", { name: "Repository to add" }).getByRole("option", { name: "cronkcorp/cronker" }).click();
  await expect(repositories.getByRole("listitem")).toHaveText(["cronkcorp/cronkerRemove"]);
  await expect(page.getByRole("listbox", { name: "Repository to add" })).toBeHidden();
  await repositories.getByRole("button", { name: "Add Repository" }).click();
  await expect(page.getByRole("listbox", { name: "Repository to add" }).getByRole("option")).toHaveText(["cronkcorp/website"]);
  await page.keyboard.press("Escape");

  // Pull Request automation is on until turned off, which sticks.
  const automation = page.getByRole("region", { name: "Pull Request automation" }).getByLabel("Merges complete their Tickets, and failures send them back");
  await expect(automation).toBeChecked();
  await automation.click();
  await expect(automation).not.toBeChecked();
  await page.reload();
  await expect(automation).not.toBeChecked();

  // Renamed on GitHub, the Repository shows its new name live.
  cronker.name = "cronk";
  cronker.fullName = "cronkcorp/cronk";
  await cronk.github.deliver(app, "repository", {
    action: "renamed",
    installation: { id: installation.id },
    repository: { id: cronker.id, name: "cronk", full_name: "cronkcorp/cronk" },
  });
  await expect(repositories.getByRole("listitem")).toHaveText(["cronkcorp/cronkRemove"]);

  await repositories.getByRole("button", { name: "Remove cronkcorp/cronk" }).click();
  await expect(repositories.getByText("The Project lists no Repositories yet.")).toBeVisible();
});

test("the Repositories section asks GitHub only once Add Repository opens its Picker, sorted and grouped by account", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  cronk.github.signedInAs = cronk.github.account("ada-gh");
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const cronkcorp = cronk.github.install(app, "cronkcorp", ["website", "Cronker", "api", "Docs"]);
  cronk.github.install(app, "bea", ["notes", "Atlas"]);
  const project = await (await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } })).json();
  await cronk.request("POST", `/api/projects/${project.id}/repositories`, { cookie, body: { id: cronkcorp.repositories[0]!.id } });

  const asked: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/github/installations") asked.push(request.url());
  });
  // GitHub answers slowly, so the Picker's loading line shows.
  let answer!: () => void;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  await page.route("**/api/github/installations", async (route) => {
    await answered;
    await route.continue();
  });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await openProjectSettings(page);

  const repositories = page.getByRole("region", { name: "Repositories" });
  await expect(repositories.getByRole("listitem")).toHaveText(["cronkcorp/websiteRemove"]);
  await expect(repositories.locator("select")).toHaveCount(0);
  expect(asked).toEqual([]);

  await repositories.getByRole("button", { name: "Add Repository" }).click();
  const picker = page.getByRole("listbox", { name: "Repository to add" });
  await expect(page.getByRole("dialog", { name: "Repository to add" })).toHaveText("Asking GitHub which Repositories the App is installed on…", { useInnerText: true });
  answer();
  await expect(picker.getByRole("option")).toHaveText(["bea/Atlas", "bea/notes", "cronkcorp/api", "cronkcorp/Cronker", "cronkcorp/Docs"]);
  await expect(picker.getByRole("group", { name: "bea" }).getByRole("option")).toHaveText(["bea/Atlas", "bea/notes"]);
  await expect(picker.getByRole("group", { name: "cronkcorp" }).getByRole("option")).toHaveText(["cronkcorp/api", "cronkcorp/Cronker", "cronkcorp/Docs"]);
  expect(asked).toHaveLength(1);

  // Typing filters; Enter picks the first match, adds it and closes the list.
  await page.getByRole("combobox", { name: "Filter Repository to add" }).fill("s");
  await expect(picker.getByRole("option")).toHaveText(["bea/Atlas", "bea/notes", "cronkcorp/Docs"]);
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(repositories.getByRole("listitem")).toHaveText(["bea/AtlasRemove", "cronkcorp/websiteRemove"]);

  // Opened again, it lists what is left without asking GitHub again.
  await repositories.getByRole("button", { name: "Add Repository" }).click();
  await expect(picker.getByRole("option")).toHaveText(["bea/notes", "cronkcorp/api", "cronkcorp/Cronker", "cronkcorp/Docs"]);
  expect(asked).toHaveLength(1);
});

test("the Repositories section says when there is no App, GitHub can't be asked, or nothing is left to add", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await openProjectSettings(page);
  const repositories = page.getByRole("region", { name: "Repositories" });
  await expect(repositories.getByText("This installation has no GitHub App yet.", { exact: false })).toBeVisible();
  await expect(repositories.getByRole("button", { name: "Add Repository" })).toHaveCount(0);

  cronk.github.signedInAs = cronk.github.account("ada-gh");
  await createGitHubApp(cronk, cookie);
  cronk.github.install(cronk.github.apps[0]!, "cronkcorp", []);
  cronk.github.unavailable = true;
  await page.reload();
  await repositories.getByRole("button", { name: "Add Repository" }).click();
  const popover = page.getByRole("dialog", { name: "Repository to add" });
  await expect(popover.getByRole("alert")).toHaveText(/^Couldn't ask GitHub which Repositories the App is installed on: GitHub couldn't be reached/);

  // Opened again, it asks again.
  await page.keyboard.press("Escape");
  cronk.github.unavailable = false;
  await repositories.getByRole("button", { name: "Add Repository" }).click();
  await expect(popover).toHaveText("No other Repository is available. Install the GitHub App on more Repositories on GitHub to add them here.", { useInnerText: true });
});
