import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("the Reopen dialog lists the Tickets it blocks that moved on, and Reopening tells each of them and sends back those chosen", async ({ page, cronk }) => {
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
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "cloud", access: "write" });
  await call("PATCH", `/api/tickets/${shipped.id}`, { delegateId: agent.id, autonomousDelegation: true, statusId: status("Code review") });
  const [run] = await call("GET", `/api/tickets/${shipped.id}/runs`);
  await cronk.request("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${secret}` }, body: { outcome: "complete" } });
  cronk.clock.advance(60_000);
  await call("PATCH", `/api/tickets/${builtOn.id}`, { statusId: status("Merge") });
  const alsoBuiltOn = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Also built on it" });
  await call("POST", `/api/tickets/${shipped.id}/relations`, { kind: "blocks", ticketId: alsoBuiltOn.id });
  await call("PATCH", `/api/tickets/${alsoBuiltOn.id}`, { statusId: status("Triage") });

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${shipped.id}`);
  await page.getByRole("region", { name: "Verification" }).getByRole("button", { name: "Reopen…" }).click();
  const dialog = page.getByRole("dialog");
  const listed = dialog.getByRole("list", { name: /moved on/ });
  await expect(listed.getByRole("listitem")).toHaveCount(2);
  await expect(listed.getByRole("listitem").first()).toContainText("CRONK-2 Built on it");
  await expect(listed.getByRole("listitem").first()).toContainText("Merge");
  await expect(dialog).toContainText("2 Tickets it blocks have moved on since it was completed. Cronk tells each, quoting your Comment.");
  const choice = (key: string) => dialog.getByRole("radiogroup", { name: `What to do with ${key}` });
  await expect(choice("CRONK-2").getByLabel("Leave it")).toBeChecked();
  await choice("CRONK-4").getByLabel("Send back").check();

  await dialog.getByLabel("Why reopen it?").fill("Not done yet.");
  await dialog.getByRole("button", { name: "Reopen" }).click();
  await expect(dialog).toHaveCount(0);
  const comments = await call("GET", `/api/tickets/${builtOn.id}/comments`);
  expect(comments.map((c: { body: string }) => c.body)).toEqual([expect.stringContaining("> Not done yet.\n\nIt was left where it is.")]);
  expect((await call("GET", `/api/tickets/${builtOn.id}`)).statusId).toBe(status("Merge"));
  expect((await call("GET", `/api/tickets/${alsoBuiltOn.id}`)).statusId).toBe(status("Backlog"));
  expect(await call("GET", `/api/tickets/${untouched.id}/comments`)).toEqual([]);
});
