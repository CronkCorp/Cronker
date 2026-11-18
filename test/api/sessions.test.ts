import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
