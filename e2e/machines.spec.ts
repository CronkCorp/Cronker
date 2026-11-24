import { setUp, signIn } from "../test/harness/flows.js";
import { openMachineStream } from "../test/harness/stream.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("a local Runner is set up, a Machine's code approved onto it, listed and unpaired", async ({ page, cronk }) => {
  await setUp(cronk);
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/runners`);

  const setup = page.getByRole("region", { name: "Set up a Runner" });
  await setup.getByLabel("Runner name").fill("Laptop");
  await setup.getByLabel("Kind").selectOption("local");
  await setup.getByRole("button", { name: "Set up a local Runner" }).click();
  await expect(page.getByRole("region", { name: "Laptop" })).toBeVisible();

  // The daemon asks for a code, as `cronk-runner login` does.
  const started = await cronk.request("POST", "/api/machines/pairings", { body: { name: "ada-laptop", os: "darwin", daemonVersion: "0.3.0" } });
  const { userCode } = await started.json();

  const machines = page.getByRole("region", { name: "Machines" });
  await expect(machines.getByText("No Machines paired yet.")).toBeVisible();
  await machines.getByLabel("Code").fill(userCode);
  await expect(machines.getByRole("checkbox", { name: "Laptop" })).toBeChecked();
  await machines.getByRole("button", { name: "Approve" }).click();

  await expect(machines.getByRole("status")).toHaveText("Paired ada-laptop. Its daemon receives its token on its next poll.");
  const row = machines.getByRole("row").filter({ hasText: "ada-laptop" });
  await expect(row).toContainText("darwin");
  await expect(row).toContainText("0.3.0");
  await expect(row).toContainText("Laptop");
  await expect(row).toContainText("Never");

  await row.getByRole("button", { name: "Unpair" }).click();
  await page.getByRole("dialog", { name: "Unpair ada-laptop?" }).getByRole("button", { name: "Unpair" }).click();
  await expect(machines.getByText("No Machines paired yet.")).toBeVisible();
});

test("approving a code that expired or was mistyped says so", async ({ page, cronk }) => {
  await setUp(cronk);
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/runners`);
  const setup = page.getByRole("region", { name: "Set up a Runner" });
  await setup.getByLabel("Runner name").fill("Laptop");
  await setup.getByLabel("Kind").selectOption("local");
  await setup.getByRole("button", { name: "Set up a local Runner" }).click();

  const machines = page.getByRole("region", { name: "Machines" });
  await machines.getByLabel("Code").fill("BCDF-GHJK");
  await machines.getByRole("button", { name: "Approve" }).click();

  await expect(machines.getByText(/No Machine is waiting with that code/)).toBeVisible();
});

test("a local Runner's card shows it offline until its Machine connects, and a daemon too old to work with", async ({ page, cronk }) => {
  await setUp(cronk);
  const ada = await signIn(cronk);
  const runner = await (await cronk.request("POST", "/api/runners", { cookie: ada, body: { name: "Laptop", kind: "local" } })).json();
  const started = await (
    await cronk.request("POST", "/api/machines/pairings", { body: { name: "ada-laptop", os: "darwin", daemonVersion: "0.3.0" } })
  ).json();
  await cronk.request("POST", "/api/machines/pairings/approve", { cookie: ada, body: { userCode: started.userCode, runnerIds: [runner.id] } });
  const { machineToken } = await (await cronk.request("POST", "/api/machines/pairings/poll", { body: { deviceCode: started.deviceCode } })).json();
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/runners`);

  const card = page.getByRole("region", { name: "Laptop" });
  await expect(card.getByRole("status")).toContainText("Offline since");
  await expect(card).toContainText("Served by ada-laptop (offline)");

  // The daemon connects, as `cronk-runner run` does: the card hears of it from the Runners stream.
  const stream = await openMachineStream(cronk, machineToken);
  await expect(card.getByText("Offline since")).toBeHidden();
  await expect(card).toContainText("Served by ada-laptop (connected)");
  await expect(page.getByRole("region", { name: "Machines" }).getByRole("row").filter({ hasText: "ada-laptop" })).toContainText("Connected");
  stream.close();
  await expect(card.getByRole("status")).toContainText("Offline since");

  // An old daemon calls: Cronk refuses it, and the card says what to upgrade to.
  const refused = await cronk.request("GET", "/api/machine", {
    headers: { authorization: `Bearer ${machineToken}`, "x-cronk-runner-version": "0.2.0" },
  });
  expect(refused.status).toBe(426);
  await page.reload();
  await expect(card).toContainText("ada-laptop runs cronk-runner 0.2.0, older than this Cronk works with: upgrade it to 0.3.0 or later.");
  await expect(page.getByRole("region", { name: "Machines" }).getByRole("row").filter({ hasText: "ada-laptop" })).toContainText("Upgrade to 0.3.0");
});

test("a local Runner's allowed tools are edited on its card, kept on reload and reset to the default", async ({ page, cronk }) => {
  await setUp(cronk);
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/runners`);
  const setup = page.getByRole("region", { name: "Set up a Runner" });
  await setup.getByLabel("Runner name").fill("Laptop");
  await setup.getByLabel("Kind").selectOption("local");
  await setup.getByRole("button", { name: "Set up a local Runner" }).click();

  const card = page.getByRole("region", { name: "Laptop" });
  const rules = card.getByRole("textbox", { name: "Allowed tools" });
  await expect(rules).toHaveValue(/^Bash\(git:\*\)\n/);
  await expect(rules).toHaveValue(/\nmcp__cronk$/);

  await rules.fill("Bash(git:*)\n\n  Bash(cargo test:*)  \n");
  await card.getByRole("button", { name: "Save allowed tools" }).click();
  await expect(card.getByText("Saved.")).toBeVisible();
  await expect(rules).toHaveValue("Bash(git:*)\nBash(cargo test:*)");

  await page.reload();
  await expect(rules).toHaveValue("Bash(git:*)\nBash(cargo test:*)");

  await card.getByRole("button", { name: "Reset to default" }).click();
  await expect(rules).toHaveValue(/^Bash\(git:\*\)\nBash\(npm:\*\)\n/);
});

test("a local Run's cost shows as an estimate on its Ticket and its Runner's card", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  await signInInBrowser(page, cronk);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await cronk.request(method, path, { cookie, body, headers: token ? { authorization: `Bearer ${token}` } : {} });
    expect(response.status, `${method} ${path}`).toBeLessThan(300);
    return response.status === 204 ? null : response.json();
  };
  const runner = await call("POST", "/api/runners", { name: "Laptop", kind: "local" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "laptop" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  // The daemon pairs, as `cronk-runner login` does.
  const started = await call("POST", "/api/machines/pairings", { name: "ada-laptop", os: "darwin", daemonVersion: "0.3.0" });
  await call("POST", "/api/machines/pairings/approve", { userCode: started.userCode, runnerIds: [runner.id] });
  const { machineToken } = await call("POST", "/api/machines/pairings/poll", { deviceCode: started.deviceCode });
  // It connects, as `cronk-runner run` does: until then the Ticket would wait for a Machine.
  const stream = await openMachineStream(cronk, machineToken);
  await call("PATCH", `/api/tickets/${ticket.id}`, {
    delegateId: agent.id,
    statusId: project.statuses.find((s: { name: string }) => s.name === "Triage").id,
  });
  const [run] = await call("GET", `/api/tickets/${ticket.id}/runs`);
  // It claims the Run, and its `claude` exits reporting what Claude Code estimated the session cost.
  await call("POST", `/api/machine/runs/${run.id}/claim`, undefined, machineToken);
  await call("POST", `/api/machine/runs/${run.id}/end`, { reason: "claude exited with code 1", costUsd: 1.37 }, machineToken);

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  await expect(page.locator(".field-row").filter({ hasText: "Cost" })).toContainText("≈ $1.37 estimated");
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText("≈ $1.37 estimated");

  await page.goto(`${cronk.url}/runners`);
  await expect(page.getByRole("region", { name: "Laptop" }).locator(".runner-cost")).toHaveText("≈ $1.37 estimated this month");
  stream.close();
});
