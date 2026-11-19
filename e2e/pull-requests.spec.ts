import { expect, test } from "./fixtures.js";
import { createGitHubApp, setUp, signIn } from "../test/harness/flows.js";

test("a Ticket shows the Pull Requests naming its key, with their state and checks, updating live", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = await created.json();
  await cronk.request("POST", `/api/projects/${project.id}/repositories`, { cookie, body: { id: cronker.id } });
  const ticket = await (
    await cronk.request("POST", `/api/projects/${project.id}/tickets`, { cookie, body: { title: "Show Pull Requests" } })
  ).json();
  const repository = { id: cronker.id, full_name: "cronkcorp/cronker" };
  const pullRequest = (fields: { draft: boolean; updated_at: string }) => ({
    action: fields.draft ? "opened" : "ready_for_review",
    installation: { id: installation.id },
    repository,
    pull_request: {
      id: 501,
      number: 7,
      title: "CRONK-1: list Pull Requests",
      state: "open",
      merged: false,
      html_url: "https://github.com/cronkcorp/cronker/pull/7",
      head: { ref: "cronk-1-list", sha: "c1" },
      ...fields,
    },
  });
  await cronk.github.deliver(app, "pull_request", pullRequest({ draft: true, updated_at: "2026-01-01T09:00:00Z" }));

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  await page.getByRole("link", { name: /CRONK-1/ }).click();

  const pullRequests = page.getByRole("region", { name: "Pull Requests" });
  await expect(pullRequests.getByRole("link", { name: "#7 CRONK-1: list Pull Requests" })).toBeVisible();
  await expect(pullRequests.getByText("Draft")).toBeVisible();

  // Marked ready and checked on GitHub, it shows so without a reload.
  await cronk.github.deliver(app, "pull_request", pullRequest({ draft: false, updated_at: "2026-01-01T10:00:00Z" }));
  await cronk.github.deliver(app, "check_run", {
    action: "completed",
    installation: { id: installation.id },
    repository,
    check_run: { id: 10, name: "test", head_sha: "c1", status: "completed", conclusion: "failure", html_url: null },
  });
  await expect(pullRequests.getByText("Open")).toBeVisible();
  await expect(pullRequests.getByLabel("1 failed: test")).toBeVisible();

  // In a Review Status, each Pull Request also shows as a card with its branch and every check.
  const inReview = project.statuses.find((s: { name: string }) => s.name === "In Review").id;
  await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { statusId: inReview } });
  const card = page.getByRole("region", { name: "Code to review" }).getByRole("article", { name: "#7 CRONK-1: list Pull Requests" });
  await expect(card).toContainText("cronk-1-list");
  await expect(card.getByRole("listitem")).toHaveText(["✗ test failed"]);
});
