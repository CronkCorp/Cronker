import { expect, test } from "./fixtures.js";
import { createGitHubApp, setUp, signIn } from "../test/harness/flows.js";

test("add a Repository the App is installed on to a Project, see its rename, and remove it", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  cronk.github.signedInAs = cronk.github.account("ada-gh");
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const [cronker] = cronk.github.install(app, "cronkcorp", ["cronker", "website"]).repositories;
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = await created.json();

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Cronker" }).click();
  await page.getByRole("link", { name: "Settings" }).click();

  const repositories = page.getByRole("region", { name: "Repositories" });
  await expect(repositories.getByText("The Project lists no Repositories yet.")).toBeVisible();
  await repositories.getByLabel("Repository to add").selectOption({ label: "cronkcorp/cronker" });
  await repositories.getByRole("button", { name: "Add Repository" }).click();
  await expect(repositories.getByRole("listitem")).toHaveText(["cronkcorp/cronkerRemove"]);
  await expect(repositories.getByLabel("Repository to add").getByRole("option")).toHaveText(["cronkcorp/website"]);

  // Renamed on GitHub, the Repository shows its new name live.
  await cronk.github.deliver(app, "repository", {
    action: "renamed",
    repository: { id: cronker!.id, name: "cronk", full_name: "cronkcorp/cronk" },
  });
  await expect(repositories.getByRole("listitem")).toHaveText(["cronkcorp/cronkRemove"]);

  await repositories.getByRole("button", { name: "Remove cronkcorp/cronk" }).click();
  await expect(repositories.getByText("The Project lists no Repositories yet.")).toBeVisible();
});
