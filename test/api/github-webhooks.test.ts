import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

async function withApp() {
  await setUp(cronk);
  await createGitHubApp(cronk, await signIn(cronk));
  return cronk.github.apps[0]!;
}

const ping = { zen: "Keep it logically awesome.", hook_id: 1 };

describe("webhooks", () => {
  test("a delivery signed with the App's webhook secret is accepted and applied", async () => {
    const app = await withApp();

    const response = await cronk.github.deliver(app, "ping", ping);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ applied: true });
  });

  test("a delivery that arrives again is applied once", async () => {
    const app = await withApp();
    await cronk.github.deliver(app, "ping", ping, { id: "delivery-1" });

    const again = await cronk.github.deliver(app, "ping", ping, { id: "delivery-1" });

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ applied: false });
    expect(await (await cronk.github.deliver(app, "ping", ping, { id: "delivery-2" })).json()).toEqual({ applied: true });
  });
});

describe("webhooks: refusals", () => {
  test("an unsigned delivery is refused", async () => {
    const app = await withApp();

    const response = await cronk.github.deliver(app, "ping", ping, { secret: null });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "invalid_signature", message: expect.any(String) } });
  });

  test("a delivery signed with another secret is refused, and isn't counted as applied", async () => {
    const app = await withApp();

    const forged = await cronk.github.deliver(app, "ping", ping, { id: "delivery-1", secret: "not the App's secret" });

    expect(forged.status).toBe(401);
    expect(await forged.json()).toEqual({ error: { code: "invalid_signature", message: expect.any(String) } });
    expect(await (await cronk.github.deliver(app, "ping", ping, { id: "delivery-1" })).json()).toEqual({ applied: true });
  });

  test("a delivery whose body was changed after signing is refused", async () => {
    const app = await withApp();
    const signature = `sha256=${createHmac("sha256", app.webhookSecret!).update(JSON.stringify(ping)).digest("hex")}`;

    const response = await cronk.request("POST", "/api/github/webhooks", {
      body: { ...ping, zen: "Merged." },
      headers: { "x-github-event": "ping", "x-github-delivery": "tampered", "x-hub-signature-256": signature },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "invalid_signature", message: expect.any(String) } });
  });

  test("without a GitHub App, every delivery is refused", async () => {
    await setUp(cronk);

    const response = await cronk.request("POST", "/api/github/webhooks", {
      body: ping,
      headers: { "x-github-event": "ping", "x-github-delivery": "1", "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "invalid_signature", message: expect.any(String) } });
  });
});
