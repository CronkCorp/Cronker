import { expect, test } from "./fixtures.js";

test("an open Runners page follows Runs starting and finishing, and a rate limit's pause, without a reload", async ({
  page,
  cronk,
}) => {
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
  const send = async (method: string, path: string, body: unknown, headers?: Record<string, string>) =>
    (await cronk.request(method, path, { cookie: headers ? undefined : cookie, headers, body })).json();
  const project = await send("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  const ticket = await send("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const runner = await send("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const created = await send("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  const agent = await send("PATCH", `/api/agents/${created.id}`, { runnerId: runner.id });
  const { secret } = await send("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  await send("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id });

  await page.getByRole("link", { name: "Runners" }).click();
  const card = page.getByRole("region", { name: "Fake" });
  await expect(card).toContainText("0 of 2 running");

  await send("PATCH", `/api/tickets/${ticket.id}`, { statusId: triage });
  await expect(card).toContainText("1 of 2 running");

  const [run] = await send("GET", `/api/tickets/${ticket.id}/runs`, undefined);
  await send("POST", `/api/runs/${run.id}/finish`, { outcome: "ready" }, { authorization: `Bearer ${secret}` });
  await expect(card).toContainText("0 of 2 running");

  cronk.runner.refuseNext({ kind: "rate_limited", message: "Too many fires.", retryAt: new Date("2026-01-01T10:00:00Z") });
  await send("PATCH", `/api/tickets/${ticket.id}`, { statusId: triage });
  await expect(card.getByRole("status")).toContainText("Rate limited");

  cronk.clock.advance(60 * 60 * 1000);
  await cronk.resumePausedRunners();
  await expect(card.getByRole("status")).toHaveCount(0);
  await expect(card).toContainText("1 of 2 running");
});
