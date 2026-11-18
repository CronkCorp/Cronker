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

describe("changing one's own password", () => {
  test("changing one's own password ends one's other sign-ins", async () => {
    await setUp(cronk);
    const here = await signIn(cronk);
    const elsewhere = await signIn(cronk);

    const changed = await cronk.request("PUT", "/api/me/password", {
      cookie: here,
      body: { currentPassword: firstUser.password, newPassword: "a brand new password" },
    });

    expect(changed.status).toBe(204);
    expect((await cronk.request("GET", "/api/me", { cookie: here })).status).toBe(200);
    expect((await cronk.request("GET", "/api/me", { cookie: elsewhere })).status).toBe(401);
    const old = await cronk.request("POST", "/api/sign-in", { body: { email: firstUser.email, password: firstUser.password } });
    expect(old.status).toBe(401);
    await signIn(cronk, firstUser.email, "a brand new password");
  });

  test("it needs the current password, and a new one of 8 characters or more", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const elsewhere = await signIn(cronk);

    const wrong = await cronk.request("PUT", "/api/me/password", {
      cookie,
      body: { currentPassword: "not my password", newPassword: "a brand new password" },
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: { code: "wrong_password", message: expect.any(String) } });

    const short = await cronk.request("PUT", "/api/me/password", {
      cookie,
      body: { currentPassword: firstUser.password, newPassword: "short" },
    });
    expect(short.status).toBe(400);

    expect((await cronk.request("GET", "/api/me", { cookie: elsewhere })).status).toBe(200);
    await signIn(cronk);
    const anonymous = await cronk.request("PUT", "/api/me/password", {
      body: { currentPassword: firstUser.password, newPassword: "a brand new password" },
    });
    expect(anonymous.status).toBe(401);
  });
});
