import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

const firstUser = { email: "ada@example.com", password: "correct horse battery", workspaceName: "Ada's Workspace" };

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
