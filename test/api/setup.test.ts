import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { firstUser } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

describe("setup", () => {
  test("a fresh installation logs a setup code, and setup with it creates the first User and Workspace", async () => {
    expect(cronk.setupCode()).toMatch(/^cronk_setup_[A-Za-z0-9_-]{20,}$/);
    expect(await (await cronk.request("GET", "/api/setup")).json()).toEqual({ needed: true });

    const response = await cronk.request("POST", "/api/setup", { body: { ...firstUser, setupCode: cronk.setupCode() } });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      user: { id: expect.any(String), email: "ada@example.com" },
      workspace: { id: expect.any(String), name: "Ada's Workspace" },
    });
    expect(await (await cronk.request("GET", "/api/setup")).json()).toEqual({ needed: false });
  });
});

describe("setup refusals", () => {
  test("setup without the right setup code is refused", async () => {
    const response = await cronk.request("POST", "/api/setup", {
      body: { ...firstUser, setupCode: "cronk_setup_guessed" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "invalid_setup_code", message: expect.any(String) } });
    expect(await (await cronk.request("GET", "/api/setup")).json()).toEqual({ needed: true });
  });

  test("setup can't run twice, even with the same setup code", async () => {
    const setupCode = cronk.setupCode();
    await cronk.request("POST", "/api/setup", { body: { ...firstUser, setupCode } });

    const again = await cronk.request("POST", "/api/setup", {
      body: { ...firstUser, email: "mallory@example.com", setupCode },
    });

    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: "already_set_up", message: expect.any(String) } });
  });
});
