import { expect, test } from "./fixtures.js";

test("turn on Autonomous Delegation, and Accept or Reopen what a Run completed", async ({ page, cronk }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const setup = await cronk.request("POST", "/api/setup", {
    body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" },
  });
  const { workspace } = await setup.json();
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();

  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const post = async (path: string, body?: unknown, method = "POST") =>
    (await cronk.request(method, path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const ticket = await post(`/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const runner = await post("/api/runners", { name: "Fake", kind: "fake" });
  const agent = await post(`/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await post(`/api/agents/${agent.id}`, { runnerId: runner.id }, "PATCH");
  const { secret } = await post(`/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  /** The Agent finishes the Ticket's running Run with the Outcome. */
  const finish = async (outcome: string) => {
    const runs = await post(`/api/tickets/${ticket.id}/runs`, undefined, "GET");
    const running = runs.find((r: { state: string }) => r.state === "running");
    const finished = await cronk.request("POST", `/api/runs/${running.id}/finish`, {
      headers: { authorization: `Bearer ${secret}` },
      body: { outcome },
    });
    expect(finished.status).toBe(200);
  };

  // The Project's default: Tickets first delegated take Autonomous Delegation.
  await page.goto(`${cronk.url}/projects/${project.id}/settings`);
  const settings = page.getByRole("region", { name: "Delegation" });
  await settings.getByLabel("Tickets first delegated get Autonomous Delegation").click();
  await expect(settings.getByLabel("Tickets first delegated get Autonomous Delegation")).toBeChecked();

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const autonomous = page.getByLabel("Autonomous Delegation: a Step may complete it, as Unverified");
  await expect(autonomous).not.toBeChecked();
  await page.getByLabel("Delegate to an Agent").click();
  await expect(autonomous).toBeChecked();
  await page.getByLabel("Status").selectOption("Code review");
  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline).toContainText("claude-max ran the Code review Step on sonnet: running");

  // The Run completes the Ticket: it shows as Unverified, in the Inbox too.
  await finish("complete");
  const verification = page.getByRole("region", { name: "Verification" });
  await expect(verification).toContainText("claude-max's Run of the Code review Step completed this. It is Unverified");
  await expect(page.getByLabel("Status")).toBeDisabled();
  const inboxLink = page.getByRole("navigation").getByRole("link", { name: /^Inbox/ });
  await expect(inboxLink).toHaveAccessibleName("Inbox, 1 waiting");

  // Reopen needs a Comment; it sends the Ticket back to Code review, where a new Run starts.
  await verification.getByRole("button", { name: "Reopen" }).click();
  await expect(verification.getByLabel("Why reopen it?")).toBeFocused();
  await verification.getByLabel("Why reopen it?").fill("The tests don't pass.");
  await verification.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByLabel("Status")).toHaveValue(status("Code review"));
  await expect(page.getByRole("region", { name: "Comments" })).toContainText("The tests don't pass.");
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
  await expect(timeline.getByText("claude-max ran the Code review Step on sonnet: running")).toHaveCount(1);

  await finish("complete");
  await inboxLink.click();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Completed by the Code review Step, Unverified");
  await items.first().getByRole("link", { name: "CRONK-1 Make it so" }).click();

  await page.getByRole("region", { name: "Verification" }).getByRole("button", { name: "Accept" }).click();
  await expect(page.getByRole("region", { name: "Verification" })).toContainText("Verified");
  await expect(page.getByLabel("Status")).toBeEnabled();
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
});
