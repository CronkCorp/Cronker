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

describe("state-changing requests from other Origins", () => {
  test("are refused", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);

    const signOut = await cronk.request("DELETE", "/api/session", { cookie, origin: "https://evil.example" });
    expect(signOut.status).toBe(403);
    expect(await signOut.json()).toEqual({ error: { code: "cross_origin", message: expect.any(String) } });
    expect((await cronk.request("GET", "/api/me", { cookie })).status).toBe(200);

    const signInElsewhere = await cronk.request("POST", "/api/session", {
      origin: "http://localhost:1234",
      body: { email: firstUser.email, password: firstUser.password },
    });
    expect(signInElsewhere.status).toBe(403);
  });

  test("are refused when the browser marks them cross-site without an Origin", async () => {
    await setUp(cronk);
    const response = await cronk.request("POST", "/api/session", {
      headers: { "sec-fetch-site": "cross-site" },
      body: { email: firstUser.email, password: firstUser.password },
    });
    expect(response.status).toBe(403);
  });

  test("from Cronk's own Origin, or from clients that send none, go through", async () => {
    await setUp(cronk);
    const fromBrowser = await cronk.request("POST", "/api/session", {
      origin: cronk.url,
      headers: { "sec-fetch-site": "same-origin" },
      body: { email: firstUser.email, password: firstUser.password },
    });
    expect(fromBrowser.status).toBe(200);
  });

  test("reads from other Origins are not state-changing and go through", async () => {
    expect((await cronk.request("GET", "/api/setup", { origin: "https://evil.example" })).status).toBe(200);
  });
});
