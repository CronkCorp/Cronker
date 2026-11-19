import type { Page } from "@playwright/test";
import type { StartedCronk } from "../test/harness/start-cronk.js";
import { expect, test } from "./fixtures.js";

// The look itself is checked by screenshots in review (docs/ui.md); these check what the Inbox's items say
// and how its split stacks on a phone.

/** Ada's Inbox with a Question (CRONK-1, with its needs you hand-back) and a Ticket to review with a Report (CRONK-2). */
async function inboxWithReport(page: Page, cronk: StartedCronk) {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const { workspace } = await (
    await cronk.request("POST", "/api/setup", { body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" } })
  ).json();
  const cookie = (await cronk.request("POST", "/api/sign-in", { body: credentials })).headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, headers ? { headers, body } : { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const asAgent = { authorization: `Bearer ${secret}` };
  const finish = async (ticketId: string, body: object) => {
    const runs = await call("GET", `/api/tickets/${ticketId}/runs`);
    const running = runs.find((r: { state: string }) => r.state === "running");
    await call("POST", `/api/runs/${running.id}/finish`, body, asAgent);
  };
  const asked = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Pick a colour" });
  await call("PATCH", `/api/tickets/${asked.id}`, { delegateId: agent.id, statusId: status("Triage") });
  await finish(asked.id, { outcome: "needs you", question: "Blue or green?" });
  const reviewed = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Cache the board" });
  await call("PATCH", `/api/tickets/${reviewed.id}`, { delegateId: agent.id, statusId: status("Code review") });
  await call("POST", `/api/tickets/${reviewed.id}/reports`, { title: "Code review report", body: "Looks good." }, asAgent);
  await finish(reviewed.id, { outcome: "approve" });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation").getByRole("link", { name: /^Inbox/ }).click();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(3);
  return { items, detail: page.getByRole("region", { name: "Selected item" }), call, workspaceId: workspace.id as string };
}

test("an Inbox item shows its kind, key, title and snippet, a Ticket to review its Report's title", async ({ page, cronk }) => {
  const { items, detail } = await inboxWithReport(page, cronk);
  await expect(items.nth(0)).toContainText("QuestionCRONK-1");
  await expect(items.nth(0)).toContainText("Blue or green?");
  await expect(items.nth(2)).toContainText("Cache the board");
  await expect(items.nth(2)).toContainText("Report: Code review report");

  // The detail names its Ticket once: its key and title, linking to it.
  await items.nth(2).getByRole("button").click();
  await expect(detail.getByText(/CRONK-2/)).toHaveCount(1);
  await expect(detail.getByRole("link", { name: "CRONK-2 Cache the board" })).toBeVisible();
});

test("on a phone the Inbox's list and detail stack, and selecting an item opens it full width", async ({ page, cronk }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { items, detail } = await inboxWithReport(page, cronk);
  await expect(detail).toBeHidden();

  await items.nth(2).getByRole("button").click();
  await expect(detail).toBeVisible();
  await expect(page.getByRole("list", { name: "Inbox" })).toBeHidden();
  const width = (await detail.boundingBox())!.width;
  expect(width).toBeGreaterThan(330);

  await detail.getByRole("button", { name: "← Inbox" }).click();
  await expect(items.nth(2)).toHaveAttribute("aria-current", "true");
  await expect(detail).toBeHidden();
});

test("a Run gone wrong and a Discovered Ticket each read as sentences in the detail", async ({ page, cronk }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const { workspace } = await (
    await cronk.request("POST", "/api/setup", { body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" } })
  ).json();
  const cookie = (await cronk.request("POST", "/api/sign-in", { body: credentials })).headers.get("set-cookie")!.split(";")[0]!;
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, headers ? { headers, body } : { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Rate-limit sign-in" });
  await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await call("GET", `/api/tickets/${ticket.id}/runs`);
  await call("POST", `/api/projects/${project.id}/tickets`, { title: "Flaky parser", runId: run.id }, { authorization: `Bearer ${secret}` });
  await cronk.runner.endWithoutFinishing(run.id, "The session crashed.");

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation").getByRole("link", { name: /^Inbox/ }).click();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  const detail = page.getByRole("region", { name: "Selected item" });
  await expect(items).toHaveCount(2);

  await expect(detail).toContainText("Its Triage Run failed: The session crashed.");
  expect(await detail.innerText()).not.toContain("crashed..");
  await expect(detail).toContainText(/claude-max ran it on haiku, started/);

  await items.nth(1).getByRole("button").click();
  await expect(detail).toContainText(/while on CRONK-1: delegate, move or dismiss it\./);
});

test("the selected item's Report follows a new Version saved while it is open, in the list and the detail", async ({ page, cronk }) => {
  const { items, detail, call, workspaceId } = await inboxWithReport(page, cronk);
  await items.nth(2).getByRole("button").click();
  await expect(detail.getByRole("link", { name: "Code review report" })).toBeVisible();

  const { items: waiting } = await call("GET", `/api/workspaces/${workspaceId}/inbox`);
  const { report } = waiting.find((item: { kind: string }) => item.kind === "review");
  await call("PATCH", `/api/documents/${report.id}`, { baseVersion: 1, title: "Code review, second look" });

  await expect(items.nth(2)).toContainText("Report: Code review, second look");
  await expect(detail.getByRole("link", { name: "Code review, second look" })).toBeVisible();
});
