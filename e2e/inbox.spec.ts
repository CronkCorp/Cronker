import { expect, fieldPicker, test } from "./fixtures.js";

test("the Inbox lists Tickets waiting for review, and it and its count update live", async ({ page, cronk }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const setup = await cronk.request("POST", "/api/setup", {
    body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" },
  });
  const { user, workspace } = await setup.json();
  const signedIn = await cronk.request("POST", "/api/sign-in", { body: credentials });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const project = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
      cookie,
      body: { name: "Cronker", key: "CRONK" },
    })
  ).json();
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const ticket = await (
    await cronk.request("POST", `/api/projects/${project.id}/tickets`, { cookie, body: { title: "Review me" } })
  ).json();
  const edit = (body: object) => cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const inboxLink = page.getByRole("navigation").getByRole("link", { name: /^Inbox/ });
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");

  await edit({ statusId: status("In Review"), assigneeId: user.id });
  await expect(inboxLink).toHaveAccessibleName("Inbox, 1 waiting");

  await inboxLink.click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(1);
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(items.first()).toContainText("Waiting for your review in In Review");
  await expect(detail.getByRole("link", { name: "CRONK-1 Review me" })).toBeVisible();

  await edit({ title: "Review me now" });
  await expect(items.first()).toContainText("Review me now");
  await expect(detail.getByRole("link", { name: "CRONK-1 Review me now" })).toBeVisible();

  // Resolved elsewhere, the selected item stays until the User moves on, its actions off.
  await edit({ statusId: status("Done") });
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Resolved elsewhere");
  await expect(detail.getByRole("note", { name: "Resolved elsewhere" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
});

test("a Run's Question waits in the Inbox, can be dismissed, and is answered by a reply on the Ticket", async ({ page, cronk }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const { workspace } = await (
    await cronk.request("POST", "/api/setup", {
      body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" },
    })
  ).json();
  const cookie = (await cronk.request("POST", "/api/sign-in", { body: credentials })).headers.get("set-cookie")!.split(";")[0]!;
  const ok = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, headers ? { headers, body } : { cookie, body })).json();
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, { title: "Pick a colour" });
  const runner = await ok("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await ok("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const asAgent = { authorization: `Bearer ${secret}` };
  const askAgain = async (question: string) => {
    const runs = await ok("GET", `/api/tickets/${ticket.id}/runs`);
    const running = runs.find((r: { state: string }) => r.state === "running");
    await ok("POST", `/api/runs/${running.id}/finish`, { outcome: "needs you", question }, asAgent);
  };
  await ok("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: status("Triage") });
  await askAgain("Should the button be **blue** or green?");

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const inboxLink = page.getByRole("navigation").getByRole("link", { name: /^Inbox/ });
  await expect(inboxLink).toHaveAccessibleName("Inbox, 2 waiting");
  await inboxLink.click();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(2);
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(items.first()).toContainText("Should the button be blue or green?");
  await expect(detail).toContainText("claude-max asks, from the Triage Step");
  await expect(detail.locator("strong", { hasText: "blue" })).toBeVisible();
  await expect(items.nth(1)).toContainText("Handed back to you in Backlog: the Triage Step finished with needs you");

  // Dismissing selects the next item.
  await detail.getByRole("button", { name: "Dismiss" }).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Handed back to you in Backlog");
  await expect(items.first()).toHaveAttribute("aria-current", "true");

  await detail.getByRole("link", { name: "CRONK-1 Pick a colour" }).click();
  const question = page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Question from claude-max" });
  await expect(question.getByText("Question", { exact: true })).toBeVisible();
  await question.getByLabel("Answer").fill("Green.");
  await question.getByRole("button", { name: "Post answer" }).click();
  await expect(fieldPicker(page, "Status")).toContainText("Triage");
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
});

test("a failed Run waits in the Inbox, and Retry starts a fresh one", async ({ page, cronk }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const setup = await cronk.request("POST", "/api/setup", {
    body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" },
  });
  const { workspace } = await setup.json();
  const signedIn = await cronk.request("POST", "/api/sign-in", { body: credentials });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await call("GET", `/api/tickets/${ticket.id}/runs`);

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation").getByRole("link", { name: /^Inbox/ }).click();
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();

  await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Its Triage Run failed: The session crashed.");

  await page.getByRole("region", { name: "Selected item" }).getByRole("button", { name: "Retry CRONK-1" }).click();
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
  expect(cronk.runner.starts).toHaveLength(2);
});

test("a Discovered Ticket an Agent filed waits in the Inbox until dismissed", async ({ page, cronk }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const setup = await cronk.request("POST", "/api/setup", {
    body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" },
  });
  const { workspace } = await setup.json();
  const signedIn = await cronk.request("POST", "/api/sign-in", { body: credentials });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await call("GET", `/api/tickets/${ticket.id}/runs`);

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const inboxLink = page.getByRole("navigation").getByRole("link", { name: /^Inbox/ });
  await inboxLink.click();
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();

  await cronk.request("POST", `/api/projects/${project.id}/tickets`, {
    headers: { authorization: `Bearer ${secret}` },
    body: { title: "Flaky parser", runId: run.id },
  });
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Discovered by claude-max while on CRONK-1");
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(detail.getByRole("link", { name: "CRONK-2 Flaky parser" })).toBeVisible();

  await detail.getByRole("button", { name: "Dismiss CRONK-2" }).click();
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
});
