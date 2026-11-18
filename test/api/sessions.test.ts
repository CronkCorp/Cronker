import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { days } from "../harness/clock.js";
import { firstUser, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

describe("signing in", () => {
  test("the first User signs in with a 30-day SameSite=Strict cookie and sees their empty Workspace", async () => {
    const { user, workspace } = await setUp(cronk);

    const response = await cronk.request("POST", "/api/session", {
      body: { email: firstUser.email, password: firstUser.password },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user });
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^cronk_session=cronk_session_[A-Za-z0-9_-]{20,};/);
    expect(setCookie).toContain("Max-Age=2592000");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const cookie = setCookie.split(";")[0]!;

    const me = await cronk.request("GET", "/api/me", { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      user,
      workspaces: [{ id: workspace.id, name: "Ada's Workspace", isAdmin: true }],
    });

    const shown = await cronk.request("GET", `/api/workspaces/${workspace.id}`, { cookie });
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual({ id: workspace.id, name: "Ada's Workspace" });
  });
});

describe("refusals", () => {
  test("a wrong password or unknown email is refused alike", async () => {
    await setUp(cronk);

    for (const body of [
      { email: firstUser.email, password: "not the password" },
      { email: "nobody@example.com", password: firstUser.password },
    ]) {
      const response = await cronk.request("POST", "/api/session", { body });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "invalid_credentials", message: expect.any(String) } });
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  });

  test("without a sign-in, the API answers 401", async () => {
    const { workspace } = await setUp(cronk);

    for (const path of ["/api/me", `/api/workspaces/${workspace.id}`]) {
      const response = await cronk.request("GET", path, { cookie: "cronk_session=cronk_session_madeup" });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "not_signed_in", message: expect.any(String) } });
    }
  });

  test("a Workspace the User doesn't belong to answers as if it didn't exist", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      const response = await cronk.request("GET", `/api/workspaces/${id}`, { cookie });
      expect(response.status).toBe(404);
    }
  });
});

describe("signing out and expiry", () => {
  test("signing out ends the sign-in and clears the cookie", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    const response = await cronk.request("DELETE", "/api/session", { cookie });

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toMatch(/^cronk_session=;.*Expires=Thu, 01 Jan 1970/);
    expect((await cronk.request("GET", "/api/me", { cookie })).status).toBe(401);
  });

  test("a sign-in lasts 30 days", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    cronk.clock.advance(days(30) - 1000);
    expect((await cronk.request("GET", "/api/me", { cookie })).status).toBe(200);

    cronk.clock.advance(1000);
    expect((await cronk.request("GET", "/api/me", { cookie })).status).toBe(401);
  });
});
