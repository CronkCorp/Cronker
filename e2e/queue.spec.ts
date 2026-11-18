import { expect, test } from "./fixtures.js";

test("board cards show Tickets waiting for a Runner slot and blocked, live", async ({ page, cronk }) => {
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
  const call = async (path: string, body?: unknown, method = "POST") =>
    (await cronk.request(method, path, { cookie, body })).json();
  const project = await call(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const runner = await call("/api/runners", { name: "Fake", kind: "fake" });
  await call(`/api/runners/${runner.id}`, { limit: 1 }, "PATCH");
  const agent = await call(`/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call(`/api/agents/${agent.id}`, { runnerId: runner.id }, "PATCH");
  const { secret } = await call(`/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  const running = await call(`/api/projects/${project.id}/tickets`, { title: "Running" });
  const waiting = await call(`/api/projects/${project.id}/tickets`, { title: "Waiting" });
  const blocker = await call(`/api/projects/${project.id}/tickets`, { title: "Blocker" });
  const blocked = await call(`/api/projects/${project.id}/tickets`, { title: "Blocked" });
  await call(`/api/tickets/${blocked.id}/relations`, { kind: "blockedBy", ticketId: blocker.id });

  await page.goto(`${cronk.url}/projects/${project.id}`);
  const triage = page.getByRole("region", { name: "Board" }).getByRole("region", { name: "Triage" });
  const keys: Record<string, string> = { Running: "CRONK-1", Waiting: "CRONK-2", Blocked: "CRONK-4" };
  const card = (title: string) => triage.getByRole("link", { name: new RegExp(`^${keys[title]} ${title}`) });
  for (const ticket of [running, waiting, blocked]) {
    cronk.clock.advance(1000);
    await call(`/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: status("Triage") }, "PATCH");
  }
  await expect(card("Running")).toContainText("Run running");
  await expect(card("Waiting")).toContainText("Waiting for a Runner slot");
  await expect(card("Blocked")).toContainText("Blocked");

  // The blocker is done: the blocked Ticket waits for a slot behind the other.
  await call(`/api/tickets/${blocker.id}`, { statusId: status("Done") }, "PATCH");
  await expect(card("Blocked")).toContainText("Waiting for a Runner slot");

  // The running Run finishes: its slot goes to the Ticket that waited longest.
  const [run] = await (await cronk.request("GET", `/api/tickets/${running.id}/runs`, { cookie })).json();
  await cronk.request("POST", `/api/runs/${run.id}/finish`, {
    headers: { authorization: `Bearer ${secret}` },
    body: { outcome: "ready" },
  });
  await expect(card("Waiting")).toContainText("Run running");
  await expect(card("Waiting")).not.toContainText("Waiting for a Runner slot");
  await expect(card("Blocked")).toContainText("Waiting for a Runner slot");
});
