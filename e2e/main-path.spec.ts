import { expect, test } from "./fixtures.js";

// The main path a new installation is used along, end to end in the browser, with the fake Runner
// standing in for claude.ai. Only the Agent's own calls (finishing its Runs) and setting up the fake
// Runner, which the web client doesn't offer, go straight to the API.
test("set up Cronk, delegate a Ticket, answer its Question, watch it move through the Steps and Accept it", async ({
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
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();

  // An Agent with a token, on a Runner.
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const fake = await cronk.request("POST", "/api/runners", { cookie, body: { name: "Fake", kind: "fake" } });
  expect(fake.status).toBe(201);
  await page.getByRole("link", { name: "Agents" }).click();
  await page.getByLabel("Agent name").fill("claude-max");
  await page.getByRole("button", { name: "Create Agent" }).click();
  await page.getByRole("link", { name: "claude-max" }).click();
  await page.getByLabel("Runner").selectOption("Fake");
  await expect(page.getByLabel("Runner")).toHaveValue(/.+/);
  await page.getByLabel("Token name").fill("cloud");
  await page.getByRole("button", { name: "Issue token" }).click();
  const secret = await page.getByLabel("Token cloud").inputValue();

  // A Project and a Ticket on its board.
  await page.getByRole("link", { name: "Ada's Workspace" }).click();
  await page.getByLabel("Project name").fill("Cronker");
  await page.getByLabel("Key").fill("CRONK");
  await page.getByRole("button", { name: "Create Project" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  await page.getByLabel("New Ticket title").fill("Make it so");
  await page.getByRole("button", { name: "Create Ticket" }).click();
  const card = board.getByRole("link", { name: /CRONK-1 Make it so/ });
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1 Make it so/ })).toBeVisible();
  const boardUrl = page.url();

  // Delegate it, with Autonomous Delegation, and send it to Triage: the first Run starts.
  await card.click();
  const ticketId = new URL(page.url()).pathname.split("/").pop();
  await page.getByLabel("Delegate to an Agent").click();
  await expect(page.getByLabel("Delegated to claude-max")).toBeChecked();
  const autonomous = page.getByLabel("Autonomous Delegation: a Step may complete it, as Unverified");
  await autonomous.click();
  await expect(autonomous).toBeChecked();
  await page.getByLabel("Status").selectOption("Triage");
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline).toContainText("claude-max ran the Triage Step on haiku: running");
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

  // Its Run asks a Question: the Ticket goes back to Backlog and the Question waits in the Inbox.
  await finish({ outcome: "needs you", question: "Should the button be **blue** or green?" });
  const inboxLink = page.getByRole("navigation").getByRole("link", { name: /^Inbox/ });
  await expect(inboxLink).toHaveAccessibleName("Inbox, 2 waiting");
  await inboxLink.click();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items.first()).toContainText("claude-max asks, from the Triage Step");
  await expect(items.first().locator("strong", { hasText: "blue" })).toBeVisible();

  // Answering it with a reply sends the Ticket back to Triage, where a new Run picks the answer up.
  await items.first().getByRole("link", { name: "CRONK-1 Make it so" }).click();
  const question = page.locator(".comment", { hasText: "Should the button be" });
  await question.getByRole("button", { name: "Reply" }).click();
  await question.getByLabel("Reply").fill("Green.");
  await question.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByLabel("Status").locator("option:checked")).toHaveText("Triage");
  await expect(timeline.getByText("claude-max ran the Triage Step on haiku: running")).toHaveCount(1);
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
  expect(cronk.runner.starts).toHaveLength(2);

  // On the board the card moves through the Steps as each Run finishes, without a reload.
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
  await finish({ outcome: "done" });
  await expect(cardIn("Code review")).toContainText("Run running");

  // Under Autonomous Delegation the Code review Step completes it, Unverified, into the Inbox.
  await finish({ outcome: "complete" });
  await expect(cardIn("Done")).toBeVisible();
  expect(cronk.runner.starts.map((s) => s.model)).toEqual(["haiku", "haiku", "sonnet", "opus", "sonnet"]);
  await expect(inboxLink).toHaveAccessibleName("Inbox, 1 waiting");
  await inboxLink.click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Completed by the Code review Step, Unverified");

  // Accepting it verifies it and empties the Inbox.
  await items.first().getByRole("link", { name: "CRONK-1 Make it so" }).click();
  const verification = page.getByRole("region", { name: "Verification" });
  await verification.getByRole("button", { name: "Accept" }).click();
  await expect(verification).toContainText("Verified");
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
});
