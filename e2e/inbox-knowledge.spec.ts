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
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
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
