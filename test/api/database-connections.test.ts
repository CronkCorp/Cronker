import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

describe("dropped database connections", () => {
  test("Postgres terminating Cronk's idle connections leaves it answering, and logs the dropped connection", async () => {
    expect((await cronk.request("GET", "/api/setup")).status).toBe(200);

    expect(await cronk.terminateIdleDatabaseConnections()).toBeGreaterThan(0);

    const dropped = () => cronk.logs.find((l) => l.msg.includes("dropped an idle database connection"));
    await expect.poll(dropped).toMatchObject({ level: 50, err: { code: "57P01" } });
    const response = await cronk.request("GET", "/api/setup");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ needed: true });
  });
});
