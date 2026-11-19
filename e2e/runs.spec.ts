import { expect, fieldPicker, pick, test } from "./fixtures.js";

test("delegate a Ticket and watch its Runs move it on the board", async ({ page, cronk }) => {
  const setup = await cronk.request("POST", "/api/setup", {
    body: {
      setupCode: cronk.setupCode(),
      email: "ada@example.com",
      password: "correct horse battery",
      workspaceName: "Ada's Workspace",
    },
  });
  const { workspace } = await setup.json();
  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Ada's Workspace" })).toBeVisible();

  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const post = async (path: string, body: unknown, method = "POST") =>
    (await cronk.request(method, path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await post(`/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const runner = await post("/api/runners", { name: "Fake", kind: "fake" });
  const agent = await post(`/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await post(`/api/agents/${agent.id}`, { runnerId: runner.id }, "PATCH");
  const { secret } = await post(`/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  await pick(page, "Delegate", "claude-max");
  await expect(fieldPicker(page, "Delegate")).toContainText("claude-max");
  await pick(page, "Status", "Triage");

  const timeline = page.getByRole("region", { name: "Timeline" });
  await expect(timeline.getByRole("listitem").filter({ hasText: "Triage · claude-max · haiku" })).toContainText("Run running");
  await expect(page.getByRole("region", { name: "Run" })).toContainText("Triage");
  await expect(timeline.getByRole("link", { name: "Session" })).toHaveAttribute("href", "https://claude.ai/code/session_1");

  // During its Run the Agent edits the Ticket and writes a Report; both show up live.
  const asAgent = { authorization: `Bearer ${secret}` };
  const edited = await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { headers: asAgent, body: { priority: "high" } });
  expect(edited.status).toBe(200);
  await expect(timeline).toContainText("claude-max changed Priority from None to High in its Triage Run");
  const reported = await cronk.request("POST", `/api/tickets/${ticket.id}/reports`, {
    headers: asAgent,
    body: { title: "Findings", body: "The bug is in **parsing**." },
  });
  expect(reported.status).toBe(201);
  const report = timeline.getByRole("article", { name: "Findings" });
  await expect(report).toContainText("The bug is in parsing.");
  // The Report is a Document with Versions, leading back to its Ticket.
  await report.getByRole("link", { name: "Findings" }).click();
  await expect(page.getByRole("heading", { name: "Findings" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Versions" })).toContainText("claude-max");
  await expect(page.getByRole("navigation", { name: "Breadcrumbs" }).getByRole("link", { name: "CRONK-1" })).toHaveAttribute(
    "href",
    `/tickets/${ticket.id}`,
  );

  await page.goto(`${cronk.url}/projects/${project.id}`);
  const board = page.getByRole("region", { name: "Board" });
  await expect(board.getByRole("region", { name: "Triage" })).toContainText("Run running");

  // The Agent finishes its Run; the card moves to Ready live.
  const [run] = await (await cronk.request("GET", `/api/tickets/${ticket.id}/runs`, { cookie })).json();
  const finished = await cronk.request("POST", `/api/runs/${run.id}/finish`, {
    headers: { authorization: `Bearer ${secret}` },
    body: { outcome: "ready" },
  });
  expect(finished.status).toBe(200);
  await expect(board.getByRole("region", { name: "Ready" })).toContainText("Make it so");
  await expect(board.getByRole("region", { name: "Triage" })).not.toContainText("Make it so");
  await expect(board.getByRole("region", { name: "Ready" })).not.toContainText("Run running");

  await page.goto(`${cronk.url}/projects/${project.id}/settings`);
  const delegation = page.getByRole("region", { name: "Delegation" });
  await delegation.getByLabel("New Tickets start delegated to their creator's Agent").click();
  await expect(delegation.getByLabel("New Tickets start delegated to their creator's Agent")).toBeChecked();
});
