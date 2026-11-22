import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("the Reopen dialog lists the Tickets it blocks that moved on, and Reopening tells each of them", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const shipped = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Shipped" });
  const builtOn = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Built on it" });
  const untouched = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Untouched" });
  for (const dependent of [builtOn, untouched]) {
    await call("POST", `/api/tickets/${shipped.id}/relations`, { kind: "blocks", ticketId: dependent.id });
  }
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "full" });
  await call("PATCH", `/api/tickets/${shipped.id}`, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Code review") });
  const [run] = await call("GET", `/api/tickets/${shipped.id}/runs`);
  await cronk.request("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` }, body: { outcome: "complete" } });
  cronk.clock.advance(60_000);
  await call("PATCH", `/api/tickets/${builtOn.id}`, { statusId: status("Merge") });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${shipped.id}`);
  await page.getByRole("region", { name: "Verification" }).getByRole("button", { name: "Reopen…" }).click();
  const dialog = page.getByRole("dialog");
  const listed = dialog.getByRole("list", { name: /moved on/ });
  await expect(listed.getByRole("listitem")).toHaveCount(1);
  await expect(listed.getByRole("listitem")).toContainText("CRONK-2 Built on it");
  await expect(listed.getByRole("listitem")).toContainText("Merge");
  await expect(dialog).toContainText("A Ticket it blocks has moved on since it was completed. Cronk tells it, quoting your Comment.");

  await dialog.getByLabel("Why reopen it?").fill("Not done yet.");
  await dialog.getByRole("button", { name: "Reopen" }).click();
  await expect(dialog).toHaveCount(0);
  const comments = await call("GET", `/api/tickets/${builtOn.id}/comments`);
  expect(comments.map((c: { body: string }) => c.body)).toEqual([expect.stringContaining("> Not done yet.")]);
  expect(await call("GET", `/api/tickets/${untouched.id}/comments`)).toEqual([]);
});
