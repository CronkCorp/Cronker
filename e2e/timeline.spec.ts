import { expect, signInInBrowser, test } from "./fixtures.js";
import { createGitHubApp, setUp, signIn } from "../test/harness/flows.js";
import type { StartedCronk } from "../test/harness/start-cronk.js";

/**
 * A Ticket an Agent works on in a Project with a Repository: its Implement Run opens a Pull Request and finishes,
 * and the `no-review` Label skips Code review, so the Ticket waits In Review.
 */
async function inReview(cronk: StartedCronk) {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  const call = async (path: string, body?: unknown, method = "POST", bearer?: string) => {
    const response = await cronk.request(method, path, bearer ? { body, headers: { authorization: `Bearer ${bearer}` } } : { cookie, body });
    expect(response.status, `${method} ${path}`).toBeLessThan(300);
    return response.json();
  };
  const project = await call(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await call(`/api/projects/${project.id}/repositories`, { id: cronker.id });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call(`/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call(`/api/agents/${agent.id}`, { runnerId: runner.id }, "PATCH");
  const { secret } = await call(`/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const ticket = await call(`/api/projects/${project.id}/tickets`, { title: "Rate-limit sign-in" });
  await call(`/api/tickets/${ticket.id}`, { delegateId: agent.id, labels: ["no-review"], statusId: status("Implement") }, "PATCH");

  const repository = { id: cronker.id, full_name: "cronkcorp/cronker" };
  const pullRequest = { id: 501, number: 212, title: "CRONK-1: rate-limit sign-in", state: "open", draft: false, merged: false,
    html_url: "https://github.com/cronkcorp/cronker/pull/212", head: { ref: "cronk-1", sha: "c1" }, updated_at: "2026-01-01T09:00:00Z" };
  const deliver = (event: string, payload: object) =>
    cronk.github.deliver(app, event, { installation: { id: installation.id }, repository, ...payload });
  const pullRequestEvent = (action: string, fields: object = {}) => deliver("pull_request", { action, pull_request: { ...pullRequest, ...fields } });
  await pullRequestEvent("opened");
  const [run] = await call(`/api/tickets/${ticket.id}/runs`, undefined, "GET");
  await call(`/api/runs/${run.id}/finish`, { outcome: "done" }, "POST", secret);
  return { ticket, deliver, pullRequestEvent, call, secret };
}

test("a failing check's send-back shows as Cronk's Comment labelled Sent back, linking the check, and Cronk's move names it", async ({ page, cronk }) => {
  const { ticket, deliver } = await inReview(cronk);
  await deliver("check_run", {
    action: "completed",
    check_run: { id: 10, name: "test", head_sha: "c1", status: "completed", conclusion: "failure", html_url: "https://github.com/cronkcorp/cronker/runs/10" },
  });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const sentBack = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Sent back by Cronk" });
  await expect(sentBack.getByText("Sent back", { exact: true })).toBeVisible();
  await expect(sentBack.getByRole("link", { name: "test" })).toHaveAttribute("href", "https://github.com/cronkcorp/cronker/runs/10");
  await expect(sentBack.getByRole("link", { name: "cronkcorp/cronker#212" })).toHaveAttribute("href", "https://github.com/cronkcorp/cronker/pull/212");

  const move = page.getByRole("region", { name: "Timeline" }).getByRole("listitem").filter({ hasText: "Cronk sent it back" });
  await expect(move).toHaveText(/^Cronk sent it back from In Review to Implement: the check test failed on cronkcorp\/cronker#212 \d\d:\d\d$/);
  await expect(move.getByRole("link", { name: "test" })).toHaveAttribute("href", "https://github.com/cronkcorp/cronker/runs/10");
});

test("each send-back from the same Pull Request names its own check, the earlier one too", async ({ page, cronk }) => {
  const { ticket, deliver, pullRequestEvent, call, secret } = await inReview(cronk);
  await deliver("check_run", {
    action: "completed",
    check_run: { id: 10, name: "lint", head_sha: "c1", status: "completed", conclusion: "failure", html_url: "https://github.com/cronkcorp/cronker/runs/10" },
  });
  // The Run the send-back started pushes a new commit and finishes, back to In Review, where its test fails.
  cronk.clock.advance(60_000);
  const running = (await call(`/api/tickets/${ticket.id}/runs`, undefined, "GET")).find((r: { state: string }) => r.state === "running");
  await call(`/api/runs/${running.id}/finish`, { outcome: "done" }, "POST", secret);
  await pullRequestEvent("synchronize", { head: { ref: "cronk-1", sha: "c2" }, updated_at: "2026-01-01T10:00:00Z" });
  cronk.clock.advance(60_000);
  await deliver("check_run", {
    action: "completed",
    check_run: { id: 11, name: "test", head_sha: "c2", status: "completed", conclusion: "failure", html_url: "https://github.com/cronkcorp/cronker/runs/11" },
  });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const moves = timeline.getByRole("listitem").filter({ hasText: "Cronk sent it back" });
  await expect(moves).toHaveText([
    /^Cronk sent it back from In Review to Implement: the check lint failed on cronkcorp\/cronker#212 \d\d:\d\d$/,
    /^Cronk sent it back from In Review to Implement: the check test failed on cronkcorp\/cronker#212 \d\d:\d\d$/,
  ]);
  await expect(moves.first().getByRole("link", { name: "lint" })).toHaveAttribute("href", "https://github.com/cronkcorp/cronker/runs/10");
  await expect(moves.last().getByRole("link", { name: "test" })).toHaveAttribute("href", "https://github.com/cronkcorp/cronker/runs/11");
  await expect(timeline.getByRole("article", { name: "Sent back by Cronk" })).toHaveCount(2);
});

test("a merge's Changes by Cronk read as one line naming who merged what, where it moved and how it completed", async ({ page, cronk }) => {
  const { ticket, pullRequestEvent } = await inReview(cronk);
  await pullRequestEvent("closed", { state: "closed", merged: true, merged_by: { login: "ada", id: 1 }, updated_at: "2026-01-01T12:00:00Z" });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByRole("listitem").filter({ hasText: "merged" })).toHaveText(
    /^Cronk completed it: @ada merged cronkcorp\/cronker#212 CRONK-1: rate-limit sign-in, moving it to Done as Unverified \d\d:\d\d$/,
  );
  await expect(timeline).not.toContainText("changed Verification");
  await expect(timeline).not.toContainText("Cronk changed Status");
});

test("a skipped Step's move by Cronk reads as one line naming the Step, its Label rule and where it moved on to", async ({ page, cronk }) => {
  const { ticket } = await inReview(cronk);

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByRole("listitem").filter({ hasText: "skipped" })).toHaveText(
    /^Cronk skipped the Code review Step \(skipped by no-review\), moving on by approve to In Review \d\d:\d\d$/,
  );
  await expect(timeline).not.toContainText("Cronk changed Status");
});

test("the timeline reads cause before effect: Cronk's move, its Sent back Comment, then the Run it started", async ({ page, cronk }) => {
  const { ticket, deliver } = await inReview(cronk);
  await deliver("check_run", {
    action: "completed",
    check_run: { id: 10, name: "test", head_sha: "c1", status: "completed", conclusion: "failure", html_url: null },
  });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const entries = page.getByRole("region", { name: "Timeline" }).getByRole("listitem");
  await expect(entries.last()).toContainText("Run running");
  const texts = await entries.allTextContents();
  const sentBackAt = texts.findIndex((t) => t.startsWith("Sent back"));
  expect(texts.findIndex((t) => t.startsWith("Cronk sent it back"))).toBe(sentBackAt - 1);
  expect(texts.findLastIndex((t) => t.includes("Run running"))).toBeGreaterThan(sentBackAt);
});

test("the timeline separates its days, and only Comments and Questions offer Reply", async ({ page, cronk }) => {
  const { ticket, deliver, call, secret } = await inReview(cronk);
  cronk.clock.advance(24 * 60 * 60 * 1000);
  await deliver("check_run", {
    action: "completed",
    check_run: { id: 10, name: "test", head_sha: "c1", status: "completed", conclusion: "failure", html_url: null },
  });
  // The Run the send-back started writes a Report.
  await call(`/api/tickets/${ticket.id}/reports`, { title: "Findings", body: "## Cause\n\nNo limit." }, "POST", secret);
  await call(`/api/tickets/${ticket.id}/comments`, { body: "Looking into it." });

  await page.clock.setFixedTime(cronk.clock.now());
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const days = timeline.getByRole("listitem").filter({ hasText: /^(Today|Yesterday|\d+ \w{3})$/ });
  await expect(days).toHaveText(["Yesterday", "Today"]);

  await expect(timeline.getByRole("button", { name: "Reply" })).toHaveCount(2);
  await expect(timeline.getByRole("article", { name: "Comment by ada@example.com" }).getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(timeline.getByRole("article", { name: "Sent back by Cronk" }).getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(timeline.getByRole("article", { name: "Findings" }).getByRole("button", { name: "Reply" })).toHaveCount(0);
});
