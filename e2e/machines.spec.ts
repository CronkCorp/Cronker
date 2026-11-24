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
