import { setUp, signIn } from "../test/harness/flows.js";
import { expect, fieldPicker, pick, signInInBrowser, test } from "./fixtures.js";

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
    "/adas-workspace/tickets/CRONK-1",
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

test("a Run gone wrong shows on the Ticket's Run card, and Retry starts a fresh one shown in its place", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (path: string, body?: unknown, method = "POST") => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const implement = project.statuses.find((s: { name: string }) => s.name === "Implement").id;
  const runner = await call("/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call(`/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call(`/api/agents/${agent.id}`, { runnerId: runner.id }, "PATCH");
  const ticket = await call(`/api/projects/${project.id}/tickets`, { title: "Make it so" });
  await call(`/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: implement }, "PATCH");
  const [run] = await call(`/api/tickets/${ticket.id}/runs`, undefined, "GET");
  await cronk.runner.endWithoutFinishing(run.id, "The session ended.");

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);

  const runCard = page.getByRole("complementary", { name: "Details" }).getByRole("region", { name: "Run" });
  await expect(runCard).toContainText("Run failed");
  await expect(runCard).toContainText("The session ended.");
  await expect(runCard).toContainText("Implement opus");
  await runCard.getByRole("button", { name: "Retry" }).click();
  // The fresh Run: its state, when it started, the Agent, the Step and its model, and the session link.
  await expect(runCard).toContainText("Run running");
  await expect(runCard).toContainText("since");
  await expect(runCard).toContainText("claude-max");
  await expect(runCard).toContainText("Implement opus");
  await expect(runCard.getByRole("link", { name: "Session" })).toHaveAttribute("href", /^https:\/\/claude\.ai\/code\/session_/);
  await expect(runCard.getByRole("button", { name: "Retry" })).toHaveCount(0);
  expect(cronk.runner.starts).toHaveLength(2);
});
