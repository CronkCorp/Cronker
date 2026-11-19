import { createGitHubApp } from "../test/harness/flows.js";
import { expect, fieldPicker, newTicket, pick, test } from "./fixtures.js";

// The main path a new installation is used along, end to end in the browser, with the fake Runner
// standing in for claude.ai and the stand-in GitHub for GitHub. Only the Agent's own calls (finishing its
// Runs), setting up the fake Runner, which the web client doesn't offer, and the GitHub App with its
// Repository, which other walks cover, go straight to the API; GitHub's webhooks come from the stand-in.
test("set up Cronk, delegate a Ticket, answer its Question, watch it move through the Steps, merge it and Accept it", async ({
  page,
  cronk,
}) => {
  // Setup with the code from the log, then sign in again.
  await page.goto(cronk.url);
  await page.getByLabel("Setup code").fill(cronk.setupCode());
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByLabel("Workspace name").fill("Ada's Workspace");
  await page.getByRole("button", { name: "Set up" }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await page.getByRole("button", { name: "ada@example.com" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();

  // An Agent with a token, on a Runner.
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const fake = await cronk.request("POST", "/api/runners", { cookie, body: { name: "Fake", kind: "fake" } });
  expect(fake.status).toBe(201);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByRole("button", { name: "New Agent" }).click();
  await page.getByLabel("Agent name").fill("claude-max");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page.getByRole("link", { name: "claude-max" }).click();
  await page.getByLabel("Runner").selectOption("Fake");
  await expect(page.getByLabel("Runner").locator("option:checked")).toHaveText("Fake");
  await page.getByRole("button", { name: "Manage tokens" }).click();
  const tokens = page.getByRole("dialog", { name: "Tokens of claude-max" });
  await tokens.getByLabel("Token name").fill("cloud");
  await tokens.getByRole("button", { name: "Issue token" }).click();
  const secret = await tokens.getByLabel("Token cloud").inputValue();
  await tokens.getByRole("button", { name: "Close" }).click();

  // A Project and a Ticket on its board.
  await page.getByRole("button", { name: "Workspace: Ada's Workspace" }).click();
  await page.getByRole("menuitem", { name: "Ada's Workspace" }).click();
  await page.getByLabel("Project name").fill("Cronker");
  await page.getByLabel("Key").fill("CRONK");
  await page.getByRole("button", { name: "Create Project" }).click();

  // The GitHub App, installed on the Repository the Project lists.
  await createGitHubApp(cronk, cookie);
  const app = cronk.github.apps[0]!;
  const installation = cronk.github.install(app, "cronkcorp", ["cronker"]);
  const cronker = installation.repositories[0]!;
  await expect(page.getByRole("heading", { name: "Cronker" })).toBeVisible();
  const projectId = new URL(page.url()).pathname.split("/").pop();
  const listed = await cronk.request("POST", `/api/projects/${projectId}/repositories`, { cookie, body: { id: cronker.id } });
  expect(listed.status).toBe(201);
  /** GitHub reports the Implement Run's Pull Request, as its webhook does. */
  const pullRequest = async (action: string, fields: Record<string, unknown>) => {
    const delivered = await cronk.github.deliver(app, "pull_request", {
      action,
      installation: { id: installation.id },
      repository: { id: cronker.id, full_name: cronker.fullName },
      pull_request: {
        id: 501,
        number: 7,
        title: "CRONK-1: make it so",
        state: "open",
        draft: false,
        merged: false,
        html_url: "https://github.com/cronkcorp/cronker/pull/7",
        head: { ref: "cronk-1-make-it-so", sha: "c1" },
        ...fields,
      },
    });
    expect(delivered.status).toBe(200);
  };
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  await newTicket(page, "Make it so");
  const card = board.getByRole("link", { name: /CRONK-1 Make it so/ });
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1 Make it so/ })).toBeVisible();
  const boardUrl = page.url();

  // Delegate it, with Autonomous Delegation, and send it to Triage: the first Run starts.
  await card.click();
  const ticketId = new URL(page.url()).pathname.split("/").pop();
  await pick(page, "Delegate", "claude-max");
  await expect(fieldPicker(page, "Delegate")).toContainText("claude-max");
  await pick(page, "Autonomous Delegation", "On");
  await expect(fieldPicker(page, "Autonomous Delegation")).toHaveAccessibleName("Autonomous Delegation On");
  await pick(page, "Status", "Triage");
  const timeline = page.getByRole("region", { name: "Timeline" });
  const runs = (step: string, model: string) =>
    timeline.getByRole("listitem").filter({ hasText: `${step} · claude-max · ${model}` });
  await expect(runs("Triage", "haiku").filter({ hasText: "Run running" })).toHaveCount(1);
  expect(cronk.runner.starts).toHaveLength(1);

  /** The Agent finishes the Ticket's running Run, as a Run's last call does. */
  const finish = async (body: { outcome: string; question?: string }) => {
    const runs = await (await cronk.request("GET", `/api/tickets/${ticketId}/runs`, { cookie })).json();
    const running = runs.find((r: { state: string }) => r.state === "running");
    const finished = await cronk.request("POST", `/api/runs/${running.id}/finish`, {
      headers: { authorization: `Bearer ${secret}` },
      body,
    });
    expect(finished.status).toBe(200);
  };

  // Its Run asks a Question: the Ticket goes back to Backlog, and the Inbox holds both the Question
  // and the Ticket handed back by the needs you Outcome.
  await finish({ outcome: "needs you", question: "Should the button be **blue** or green?" });
  const inboxLink = page.getByRole("navigation").getByRole("link", { name: /^Inbox/ });
  await expect(inboxLink).toHaveAccessibleName("Inbox, 2 waiting");
  await inboxLink.click();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(items.first()).toContainText("Should the button be blue or green?");
  await expect(detail).toContainText("claude-max asks, from the Triage Step");
  await expect(detail.locator("strong", { hasText: "blue" })).toBeVisible();

  // Answering it with a reply sends the Ticket back to Triage, where a new Run picks the answer up.
  await detail.getByRole("link", { name: "CRONK-1 Make it so" }).click();
  const question = timeline.getByRole("article", { name: "Question from claude-max" });
  await expect(question).toContainText("Waiting for an answer");
  await question.getByLabel("Answer").fill("Green.");
  await question.getByRole("button", { name: "Post answer" }).click();
  await expect(fieldPicker(page, "Status")).toContainText("Triage");
  await expect(question).toContainText("Answered");
  await expect(runs("Triage", "haiku").filter({ hasText: "Run running" })).toHaveCount(1);
  await expect(runs("Triage", "haiku").filter({ hasText: "Run finished" })).toContainText("needs you → Backlog");
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
  expect(cronk.runner.starts).toHaveLength(2);

  // On the board the Ticket moves from Status to Status as each Step's Run finishes, without a reload.
  await page.goto(boardUrl);
  const cardIn = (status: string) => lane(status).getByRole("link", { name: /CRONK-1 Make it so/ });
  await expect(cardIn("Triage")).toContainText("Run running");
  await finish({ outcome: "ready" });
  await expect(cardIn("Ready")).toBeVisible();
  await expect(cardIn("Ready")).not.toContainText("Run running");

  // Ready has no Step, so it waits for a User to send it on.
  await card.dragTo(lane("Investigate"));
  await expect(cardIn("Investigate")).toContainText("Run running");
  await finish({ outcome: "done" });
  await expect(cardIn("Implement")).toContainText("Run running");
  // The Implement Run opens a Pull Request naming the Ticket's key.
  await pullRequest("opened", { updated_at: "2026-01-01T09:00:00Z" });
  await finish({ outcome: "done" });
  await expect(cardIn("Code review")).toContainText("Run running");
  await finish({ outcome: "approve" });
  await expect(cardIn("In Review")).toBeVisible();

  // Merged on GitHub by someone who isn't a User here, the Pull Request completes the Ticket, Unverified, into
  // the Inbox: the card moves to Done without a reload.
  await pullRequest("closed", {
    state: "closed",
    merged: true,
    merged_by: { login: "mallory", id: 666, type: "User" },
    updated_at: "2026-01-01T10:00:00Z",
  });
  // Done starts collapsed to its dot and count.
  await lane("Done").getByRole("button", { name: "Done, 1 Ticket" }).click();
  await expect(cardIn("Done")).toBeVisible();
  expect(cronk.runner.starts.map((s) => s.model)).toEqual(["haiku", "haiku", "sonnet", "opus", "sonnet"]);
  await expect(inboxLink).toHaveAccessibleName("Inbox, 1 waiting");
  await inboxLink.click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Completed by the Implement Step, Unverified");

  // Accepting it verifies it and empties the Inbox.
  await detail.getByRole("link", { name: "CRONK-1 Make it so" }).click();
  await expect(timeline).toContainText("completed it: @mallory merged cronkcorp/cronker#7 CRONK-1: make it so");
  const verification = page.getByRole("region", { name: "Verification" });
  await expect(verification).toContainText(
    "@mallory merged cronkcorp/cronker#7, completing this. It is Unverified until you Accept it, or Reopen it to send it back to the Implement Step.",
  );
  await verification.getByRole("button", { name: "Accept" }).click();
  await expect(verification).toContainText("Verified");
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
});
