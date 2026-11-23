import { setUp } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("an Agent's page shows its Record: a Run, a Comment and a saved Version, and follows live updates", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  await signInInBrowser(page, cronk);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "write" });
  const asAgent = async (method: string, path: string, body?: unknown) =>
    (await cronk.request(method, path, { headers: { authorization: `Bearer ${secret}` }, body })).json();
  await call("PATCH", `/api/tickets/${ticket.id}`, {
    delegateId: agent.id,
    statusId: project.statuses.find((s: { name: string }) => s.name === "Triage").id,
  });
  cronk.clock.advance(1000);
  await asAgent("POST", `/api/tickets/${ticket.id}/comments`, { body: "Looking into it." });
  cronk.clock.advance(1000);
  await asAgent("POST", `/api/projects/${project.id}/documents`, { title: "The plan", body: "One." });

  await page.goto(`${cronk.url}/adas-workspace/agents`);
  await page.getByRole("link", { name: "claude-max" }).click();

  const record = page.getByRole("list", { name: "Record" });
  await expect(record.getByRole("listitem")).toHaveCount(3);
  await expect(record.getByRole("listitem").nth(0)).toContainText("saved Version 1 of the Document The plan");
  await expect(record.getByRole("listitem").nth(1)).toContainText("Looking into it.");
  await expect(record.getByRole("listitem").nth(2)).toContainText("Triage");
  await expect(record.getByRole("listitem").nth(2)).toContainText("CRONK-1");
  await expect(record.getByRole("link", { name: "The plan" })).toBeVisible();

  // What the Agent does next shows while the page is open.
  cronk.clock.advance(1000);
  await asAgent("POST", `/api/tickets/${ticket.id}/comments`, { body: "Found it." });
  await expect(record.getByRole("listitem").nth(0)).toContainText("Found it.");
});
