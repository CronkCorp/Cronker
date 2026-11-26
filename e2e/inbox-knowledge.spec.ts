import { expect, test } from "./fixtures.js";

test("New knowledge an Agent created waits in the Inbox, shown inline, until accepted or dismissed, and arrives live", async ({
  page,
  cronk,
}) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const { workspace } = await (
    await cronk.request("POST", "/api/setup", { body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" } })
  ).json();
  const cookie = (await cronk.request("POST", "/api/sign-in", { body: credentials })).headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, headers ? { headers, body } : { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "write" });
  const asAgent = { authorization: `Bearer ${secret}` };
  await call("POST", `/api/projects/${project.id}/decisions`, { title: "Use Postgres", body: "It **keeps** everything." }, asAgent);
  cronk.clock.advance(1000);
  await call("POST", `/api/workspaces/${workspace.id}/terms`, { name: "Run", definition: "One go at a Ticket.", avoid: ["Job"] }, asAgent);

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation").getByRole("link", { name: /^Inbox/ }).click();
  const list = page.getByRole("list", { name: "Inbox" });
  const items = list.getByRole("listitem");
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(list).toContainText("New knowledge · 2");
  await expect(items).toHaveCount(2);

  // The proposed Decision, rendered inline with its status, links to its own page and offers Accept and Reject.
  await expect(items.nth(0)).toContainText("Use Postgres");
  await expect(detail.getByRole("link", { name: "CRONK Use Postgres" })).toHaveAttribute("href", /\/projects\/CRONK\/decisions\/1$/);
  await expect(detail).toContainText("Proposed by claude-max");
  await expect(detail.getByText("keeps")).toBeVisible();
  await expect(detail.getByRole("button", { name: "Reject" })).toBeVisible();
  await detail.getByRole("button", { name: "Accept" }).click();

  // Accepting clears it, selecting the Term: its definition and words to avoid.
  await expect(items).toHaveCount(1);
  await expect(detail).toContainText("One go at a Ticket.");
  await expect(detail).toContainText("Avoid: Job");
  await expect(detail.getByRole("button", { name: "Accept" })).toHaveCount(0);
  expect((await call("GET", `/api/projects/${project.id}/decisions`))[0].status).toBe("accepted");

  // A Document the Agent creates meanwhile arrives without a reload.
  await call("POST", `/api/projects/${project.id}/documents`, { title: "Plan", body: "Steps." }, asAgent);
  await expect(items).toHaveCount(2);
  await expect(list).toContainText("Plan");

  await detail.getByRole("button", { name: "Dismiss Term Run" }).click();
  await expect(items).toHaveCount(1);
  await expect(detail).toContainText("Steps.");
  await detail.getByRole("button", { name: "Dismiss Document Plan" }).click();
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
});

test("The sidebar's knowledge links count the New knowledge of their kind waiting for their place, live", async ({ page, cronk }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const { workspace } = await (
    await cronk.request("POST", "/api/setup", { body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" } })
  ).json();
  const cookie = (await cronk.request("POST", "/api/sign-in", { body: credentials })).headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, headers ? { headers, body } : { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "write" });
  const asAgent = { authorization: `Bearer ${secret}` };
  await call("POST", `/api/projects/${project.id}/decisions`, { title: "Use Postgres", body: "Why." }, asAgent);
  // The Workspace's own Term counts on the Workspace's Terms link, not the Project's; a User's Document counts nowhere.
  await call("POST", `/api/workspaces/${workspace.id}/terms`, { name: "Run", definition: "One go at a Ticket." }, asAgent);
  await call("POST", `/api/projects/${project.id}/documents`, { title: "Notes", body: "Mine." });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await expect(sidebar.getByRole("link", { name: "Decisions, 1 new" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Terms", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Documents", exact: true })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: /^Inbox, 2 waiting$/ })).toBeVisible();

  // An Agent's Document raises its count without a reload; dismissing it lowers it.
  const plan = await call("POST", `/api/projects/${project.id}/documents`, { title: "Plan", body: "Steps." }, asAgent);
  await expect(sidebar.getByRole("link", { name: "Documents, 1 new" })).toBeVisible();
  // A new Version of it adds nothing.
  await call("PATCH", `/api/documents/${plan.id}`, { title: "Plan", body: "More steps.", baseVersion: 1 }, asAgent);
  await sidebar.getByRole("link", { name: /^Inbox/ }).click();
  const detail = page.getByRole("region", { name: "Selected item" });
  await page.getByRole("list", { name: "Inbox" }).getByText("Plan").click();
  await expect(sidebar.getByRole("link", { name: "Documents, 1 new" })).toBeVisible();
  await detail.getByRole("button", { name: "Dismiss Document Plan" }).click();
  await expect(sidebar.getByRole("link", { name: "Documents", exact: true })).toBeVisible();

  // Accepting the proposed Decision clears its count, and the badge stays inside the 232px sidebar.
  const decisions = sidebar.getByRole("link", { name: "Decisions, 1 new" });
  const badge = await decisions.locator(".count").boundingBox();
  const link = await decisions.boundingBox();
  expect(badge!.x + badge!.width).toBeLessThanOrEqual(link!.x + link!.width);
  await page.getByRole("list", { name: "Inbox" }).getByText("Use Postgres").click();
  await detail.getByRole("button", { name: "Accept" }).click();
  await expect(sidebar.getByRole("link", { name: "Decisions", exact: true })).toBeVisible();
});
