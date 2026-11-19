import { expect, signInInBrowser, test } from "./fixtures.js";
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
  await cronk.github.deliver(app, "pull_request_review", {
    ...pullRequest({ draft: false, updated_at: "2026-01-01T10:00:00Z" }),
    action: "submitted",
    review: { id: 70, state: "approved", user: { login: "bea", id: 4070 }, html_url: "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-70" },
  });
  await expect(card.getByRole("link", { name: "Approved by @bea" })).toBeVisible();
});

test("a Pull Request's row shows its review state: changes requested, approved, then who merged it", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  const call = async (path: string, body?: unknown, method = "POST") => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await call(`/api/projects/${project.id}/repositories`, { id: cronker.id });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call(`/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call(`/api/agents/${agent.id}`, { runnerId: runner.id }, "PATCH");
  const { secret } = await call(`/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const ticket = await call(`/api/projects/${project.id}/tickets`, { title: "Make it so" });
  await call(`/api/tickets/${ticket.id}`, { delegateId: agent.id, labels: ["no-review"], statusId: status("Implement") }, "PATCH");

  const repository = { id: cronker.id, full_name: "cronkcorp/cronker" };
  const pullRequest = { id: 501, number: 7, title: "CRONK-1: make it so", state: "open", draft: false, merged: false,
    html_url: "https://github.com/cronkcorp/cronker/pull/7", head: { ref: "cronk-1", sha: "c1" }, updated_at: "2026-01-01T09:00:00Z" };
  const event = (action: string, fields: object = {}) => ({ action, installation: { id: installation.id }, repository, pull_request: { ...pullRequest, ...fields } });
  // The Implement Run opens it, then finishes: the Ticket waits In Review.
  await cronk.github.deliver(app, "pull_request", event("opened"));
  const [run] = await call(`/api/tickets/${ticket.id}/runs`, undefined, "GET");
  const finished = await cronk.request("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` }, body: { outcome: "done" } });
  expect(finished.status).toBe(200);
  await cronk.github.deliver(app, "pull_request_review", {
    ...event("submitted"),
    review: { id: 72, state: "changes_requested", user: { login: "bea", id: 4072 }, html_url: "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-72" },
  });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);

  const row = page.getByRole("region", { name: "Pull Requests" }).getByRole("listitem").filter({ hasText: "#7 CRONK-1: make it so" });
  await expect(row).toContainText("Open");
  await expect(row.getByRole("link", { name: "Changes requested by @bea" })).toHaveAttribute(
    "href",
    "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-72",
  );

  // An approval from a later review replaces the requested changes, without a reload.
  await cronk.github.deliver(app, "pull_request_review", {
    ...event("submitted"),
    review: { id: 73, state: "approved", user: { login: "bea", id: 4072 }, html_url: "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-73" },
  });
  await expect(row.getByRole("link", { name: "Approved by @bea" })).toHaveAttribute(
    "href",
    "https://github.com/cronkcorp/cronker/pull/7#pullrequestreview-73",
  );
  await expect(row).not.toContainText("Changes requested");

  await cronk.github.deliver(app, "pull_request", event("closed", { state: "closed", merged: true, merged_by: { login: "ada", id: 1 }, updated_at: "2026-01-01T12:00:00Z" }));
  await expect(row).toContainText("Merged");
  await expect(row).toContainText("Merged by @ada");
});
