import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, firstUser, setUp, signIn } from "../harness/flows.js";
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

describe("unused reset links", () => {
  test("end when the password changes, by hand or by another reset link", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const issue = async () =>
      new URL(
        (await (await cronk.request("POST", `/api/workspaces/${workspace.id}/members/${bea.user.id}/reset-link`, { cookie })).json()).url,
      ).hash.slice(1);
    const first = await issue();
    const second = await issue();
    const third = await issue();

    await cronk.request("PUT", "/api/me/password", {
      cookie: bea.cookie,
      body: { currentPassword: bea.password, newPassword: "bea's second password" },
    });
    expect((await cronk.request("POST", "/api/links/use", { body: { token: first, password: "mallory's password" } })).status).toBe(404);

    const fourth = await issue();
    expect((await cronk.request("POST", "/api/links/use", { body: { token: fourth, password: "bea's third password" } })).status).toBe(200);
    for (const token of [second, third]) {
      expect((await cronk.request("POST", "/api/links/use", { body: { token, password: "mallory's password" } })).status).toBe(404);
    }
    await signIn(cronk, "bea@example.com", "bea's third password");
  });
});

describe("the reset-link server command", () => {
  test("issues a reset link for any User, for when nobody can sign in", async () => {
    const { user } = await setUp(cronk);
    const cookie = await signIn(cronk);

    const result = await cronk.command("reset-link", "ADA@example.com");

    expect(result.code).toBe(0);
    const url = result.stdout.match(/https?:\/\/\S+/)?.[0];
    expect(url).toMatch(new RegExp(`^${cronk.url}/link#cronk_reset_[A-Za-z0-9_-]{20,}$`));
    expect(result.stdout).toContain("ada@example.com");
    const token = new URL(url!).hash.slice(1);
    const used = await cronk.request("POST", "/api/links/use", { body: { token, password: "recovered at last" } });
    expect(await used.json()).toEqual({ user });
    expect((await cronk.request("GET", "/api/me", { cookie })).status).toBe(401);
    await signIn(cronk, firstUser.email, "recovered at last");
  });

  test("says so when no User has the email", async () => {
    await setUp(cronk);

    const result = await cronk.command("reset-link", "nobody@example.com");

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No User has the email nobody@example.com");
  });

  test("explains its usage", async () => {
    const result = await cronk.command();

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("reset-link <email>");
  });
});
