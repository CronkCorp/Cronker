import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

interface As {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: As, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: As, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/** Ada's Workspace, signed in. */
async function adasWorkspace() {
  const { user, workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const slug = (await ok("GET", `/api/workspaces/${workspace.id}`, ada)).slug as string;
  return { ada, adaId: user.id, workspace: { ...workspace, slug }, hooks: `/api/workspaces/${workspace.id}/webhooks` };
}

/** Verifies a delivery as a Standard Webhooks verifier would, with the `whsec_` secret. */
function verifies(secret: string, headers: Record<string, string | string[] | undefined>, body: string): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`).digest("base64");
  return String(headers["webhook-signature"]).split(" ").includes(`v1,${expected}`);
}

describe("a User's webhooks", () => {
  test("a User adds a webhook, which defaults to where work stalls and shows its secret only once", async () => {
    const { ada, hooks, workspace } = await adasWorkspace();
    const created = await call("POST", hooks, ada, { name: "Phone", url: "https://ntfy.sh/ada-cronk" });
    expect(created.status).toBe(201);
    expect(created.json).toEqual({
      id: expect.any(String),
      workspaceId: workspace.id,
      name: "Phone",
      url: "https://ntfy.sh/ada-cronk",
      kinds: ["question", "needsYou", "run"],
      enabled: true,
      failing: false,
      createdAt: "2026-01-01T09:00:00.000Z",
      secret: expect.stringMatching(/^whsec_[A-Za-z0-9+/]{43}=$/),
    });
    const { secret, ...shown } = created.json;
    expect(await ok("GET", hooks, ada)).toEqual([shown]);
    expect(await ok("GET", `${hooks}/${shown.id}`, ada)).toEqual(shown);
    expect(JSON.stringify(await ok("GET", hooks, ada))).not.toContain(secret);
  });

  test("a User edits a webhook's name, URL, kinds and on or off, and removes it", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Phone", url: "https://ntfy.sh/a", kinds: ["review"] });
    const edited = await ok("PATCH", `${hooks}/${id}`, ada, {
      name: "Home",
      url: "https://n8n.example.com/hook",
      kinds: ["question", "unverified", "discovered", "reassign"],
      enabled: false,
    });
    expect(edited).toMatchObject({ name: "Home", url: "https://n8n.example.com/hook", kinds: ["question", "unverified", "discovered", "reassign"], enabled: false });
    expect(await ok("PATCH", `${hooks}/${id}`, ada, { enabled: true })).toMatchObject({ name: "Home", enabled: true });

    expect((await call("DELETE", `${hooks}/${id}`, ada)).status).toBe(204);
    expect(await ok("GET", hooks, ada)).toEqual([]);
    expect((await call("GET", `${hooks}/${id}`, ada)).json.error.code).toBe("not_found");
  });

  test("only https URLs are accepted, or plain http to a local address on a local Cronk", async () => {
    const { ada, hooks } = await adasWorkspace();
    for (const url of ["https://ntfy.sh/a", "http://127.0.0.1:8080/hook", "http://localhost/hook", "http://[::1]:9000/"]) {
      expect((await call("POST", hooks, ada, { name: "Hook", url })).status, url).toBe(201);
    }
    for (const url of ["http://ntfy.sh/a", "http://192.168.1.10/hook", "ftp://example.com/", "not a url", "https://user:pw@example.com/"]) {
      const refused = await call("POST", hooks, ada, { name: "Hook", url });
      expect(refused.status, url).toBe(400);
      expect(refused.json.error.code, url).toBe("invalid_webhook_url");
    }
    const { id } = await ok("POST", hooks, ada, { name: "Hook", url: "https://ntfy.sh/a" });
    expect((await call("PATCH", `${hooks}/${id}`, ada, { url: "http://ntfy.sh/a" })).json.error.code).toBe("invalid_webhook_url");
    expect((await call("POST", hooks, ada, { name: "Hook", url: "https://ntfy.sh/a", kinds: [] })).json.error.code).toBe("no_webhook_kinds");
    expect((await call("POST", hooks, ada, { name: "Hook", url: "https://ntfy.sh/a", kinds: ["comment"] })).status).toBe(400);
  });

  test("each User sees and changes only their own webhooks, and only in Workspaces they belong to", async () => {
    const { ada, hooks, workspace } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Ada's", url: "https://ntfy.sh/a" });
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const asBea = { cookie: bea.cookie };
    expect(await ok("GET", hooks, asBea)).toEqual([]);
    for (const [method, path, body] of [
      ["GET", `${hooks}/${id}`],
      ["PATCH", `${hooks}/${id}`, { name: "Bea's now" }],
      ["DELETE", `${hooks}/${id}`],
      ["POST", `${hooks}/${id}/test`],
      ["GET", `${hooks}/${id}/deliveries`],
    ] as [string, string, unknown?][]) {
      const refused = await call(method, path, asBea, body);
      expect(refused.status, `${method} ${path}`).toBe(404);
    }
    const other = await ok("POST", "/api/workspaces", asBea, { name: "Bea's Workspace" });
    expect((await call("GET", `/api/workspaces/${other.id}/webhooks`, ada)).status).toBe(404);
    expect(await ok("GET", hooks, ada)).toEqual([expect.objectContaining({ id, name: "Ada's" })]);
  });

  test("Agents are refused every webhook route, and never see webhooks", async () => {
    const { ada, hooks, workspace } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Ada's", url: "https://ntfy.sh/a" });
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
    const asAgent = { headers: { authorization: `Bearer ${secret}` } };
    for (const [method, path, body] of [
      ["GET", hooks],
      ["POST", hooks, { name: "Redirected", url: "https://evil.example.com/" }],
      ["GET", `${hooks}/${id}`],
      ["PATCH", `${hooks}/${id}`, { url: "https://evil.example.com/" }],
      ["DELETE", `${hooks}/${id}`],
      ["POST", `${hooks}/${id}/test`],
      ["GET", `${hooks}/${id}/deliveries`],
    ] as [string, string, unknown?][]) {
      const refused = await call(method, path, asAgent, body);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.json.error, `${method} ${path}`).toEqual(
        expect.objectContaining({ code: "agent_not_allowed", rule: expect.any(String), advice: expect.any(String) }),
      );
    }
    expect(await ok("GET", hooks, ada)).toEqual([expect.objectContaining({ id, name: "Ada's", url: "https://ntfy.sh/a" })]);
  });

  test("a webhook can't be added without CRONK_SECRET_KEY to keep its secret with", async () => {
    await cronk.stop();
    cronk = await startCronk({ noSecretKey: true });
    const { ada, hooks } = await adasWorkspace();
    const refused = await call("POST", hooks, ada, { name: "Phone", url: "https://ntfy.sh/a" });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("no_secret_key");
    expect(await ok("GET", hooks, ada)).toEqual([]);
  });
});

describe("Send test", () => {
  test("a test delivery reaches the receiver signed with the webhook's secret, and is listed with its status code", async () => {
    const { ada, hooks, workspace } = await adasWorkspace();
    const { id, secret } = await ok("POST", hooks, ada, { name: "Receiver", url: `${cronk.webhooks.url}/cronk` });
    const queued = await call("POST", `${hooks}/${id}/test`, ada);
    expect(queued.status).toBe(201);
    expect(queued.json).toEqual({
      id: expect.any(String),
      kind: "test",
      createdAt: "2026-01-01T09:00:00.000Z",
      state: "pending",
      statusCode: null,
      error: null,
      sentAt: null,
      nextAt: "2026-01-01T09:00:00.000Z",
      attempts: [],
    });
    expect(cronk.webhooks.received).toEqual([]);

    await cronk.deliverWebhooks();
    expect(cronk.webhooks.received).toHaveLength(1);
    const [delivery] = cronk.webhooks.received;
    expect(delivery!.path).toBe("/cronk");
    expect(delivery!.headers["content-type"]).toBe("application/json");
    expect(delivery!.headers["webhook-id"]).toBe(queued.json.id);
    expect(delivery!.headers["webhook-timestamp"]).toBe(String(Date.parse("2026-01-01T09:00:00.000Z") / 1000));
    expect(JSON.parse(delivery!.body)).toEqual({
      id: queued.json.id,
      kind: "test",
      workspace: workspace.slug,
      ticket: { key: "TEST-1", title: "Test delivery", url: `${cronk.url}/${workspace.slug}` },
      at: "2026-01-01T09:00:00.000Z",
    });
    expect(verifies(secret, delivery!.headers, delivery!.body)).toBe(true);
    expect(verifies(`whsec_${Buffer.alloc(32).toString("base64")}`, delivery!.headers, delivery!.body)).toBe(false);

    expect(await ok("GET", `${hooks}/${id}/deliveries`, ada)).toEqual([
      {
        ...queued.json,
        state: "delivered",
        statusCode: 204,
        sentAt: "2026-01-01T09:00:00.000Z",
        nextAt: null,
        attempts: [{ at: "2026-01-01T09:00:00.000Z", statusCode: 204, error: null }],
      },
    ]);
    await cronk.deliverWebhooks();
    expect(cronk.webhooks.received).toHaveLength(1);
  });

  test("a receiver that fails or doesn't answer is recorded, and the delivery waits for a retry", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Receiver", url: cronk.webhooks.url, enabled: false });
    cronk.webhooks.failNext(1, 500);
    cronk.webhooks.failNext(1, "drop");
    await ok("POST", `${hooks}/${id}/test`, ada);
    cronk.clock.advance(1000);
    await ok("POST", `${hooks}/${id}/test`, ada);
    await cronk.deliverWebhooks();
    const deliveries = await ok("GET", `${hooks}/${id}/deliveries`, ada);
    expect(deliveries.map((d: { state: string }) => d.state)).toEqual(["pending", "pending"]);
    expect(deliveries.map((d: { statusCode: number | null }) => d.statusCode).sort()).toEqual([500, null]);
    expect(deliveries.find((d: { statusCode: number | null }) => d.statusCode === null).error).toEqual(expect.any(String));
    for (const d of deliveries) {
      expect(d.sentAt).toBeNull();
      expect(d.nextAt).toBe("2026-01-01T09:00:31.000Z");
      expect(d.attempts).toEqual([{ at: "2026-01-01T09:00:01.000Z", statusCode: d.statusCode, error: d.error }]);
    }
  });

  test("a failed delivery is retried about 30 seconds later, and delivered then", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Receiver", url: cronk.webhooks.url });
    cronk.webhooks.failNext(1, 503);
    const queued = await ok("POST", `${hooks}/${id}/test`, ada);
    await cronk.deliverWebhooks();
    cronk.clock.advance(29_000);
    await cronk.deliverWebhooks();
    expect(cronk.webhooks.received).toHaveLength(1);
    cronk.clock.advance(1_000);
    await cronk.deliverWebhooks();
    expect(cronk.webhooks.received.map((r) => r.answer)).toEqual([503, 204]);
    // The retry sends the same body under the same id, signed afresh.
    expect(cronk.webhooks.received[1]!.body).toBe(cronk.webhooks.received[0]!.body);
    expect(cronk.webhooks.received[1]!.headers["webhook-id"]).toBe(queued.id);
    expect(cronk.webhooks.received[1]!.headers["webhook-timestamp"]).toBe(String(Date.parse("2026-01-01T09:00:30.000Z") / 1000));

    expect(await ok("GET", `${hooks}/${id}/deliveries`, ada)).toEqual([
      expect.objectContaining({
        state: "delivered",
        statusCode: 204,
        sentAt: "2026-01-01T09:00:30.000Z",
        nextAt: null,
        attempts: [
          { at: "2026-01-01T09:00:00.000Z", statusCode: 503, error: null },
          { at: "2026-01-01T09:00:30.000Z", statusCode: 204, error: null },
        ],
      }),
    ]);
    expect((await ok("GET", `${hooks}/${id}`, ada)).failing).toBe(false);
  });

  test("retries back off, doubling from 30 seconds, and after about 24 hours the webhook is marked failing", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Receiver", url: cronk.webhooks.url });
    cronk.webhooks.failNext(13, 500);
    await ok("POST", `${hooks}/${id}/test`, ada);
    const queuedAt = Date.parse("2026-01-01T09:00:00.000Z");
    // Each retry is due 30s · 2^(n-1) after the nth try, the last moved in to land 24 hours after it was queued.
    const offsets = [0];
    for (let n = 1; n <= 11; n++) offsets.push(offsets[n - 1]! + 30_000 * 2 ** (n - 1));
    offsets.push(24 * 60 * 60_000);
    expect(offsets).toHaveLength(13);

    let at = queuedAt;
    for (const [i, offset] of offsets.entries()) {
      // A second before it is due, nothing is sent.
      if (i > 0) {
        cronk.clock.advance(queuedAt + offset - 1000 - at);
        await cronk.deliverWebhooks();
        expect(cronk.webhooks.received, `try ${i + 1}`).toHaveLength(i);
        cronk.clock.advance(1000);
        at = queuedAt + offset;
      }
      await cronk.deliverWebhooks();
      expect(cronk.webhooks.received, `try ${i + 1}`).toHaveLength(i + 1);
      const [delivery] = await ok("GET", `${hooks}/${id}/deliveries`, ada);
      const webhook = await ok("GET", `${hooks}/${id}`, ada);
      if (i < offsets.length - 1) {
        expect(delivery.state, `try ${i + 1}`).toBe("pending");
        expect(delivery.nextAt, `try ${i + 1}`).toBe(new Date(queuedAt + offsets[i + 1]!).toISOString());
        expect(webhook.failing, `try ${i + 1}`).toBe(false);
      } else {
        expect(delivery.state).toBe("failed");
        expect(delivery.sentAt).toBe("2026-01-02T09:00:00.000Z");
        expect(delivery.nextAt).toBeNull();
        expect(delivery.attempts.map((a: { at: string }) => Date.parse(a.at) - queuedAt)).toEqual(offsets);
        expect(delivery.attempts.every((a: { statusCode: number }) => a.statusCode === 500)).toBe(true);
        expect(webhook.failing).toBe(true);
      }
    }
    cronk.clock.advance(60 * 60_000);
    await cronk.deliverWebhooks();
    expect(cronk.webhooks.received).toHaveLength(13);
    expect(await ok("GET", hooks, ada)).toEqual([expect.objectContaining({ id, failing: true })]);
  });

  test("a late retry past the deadline is the last one", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Receiver", url: cronk.webhooks.url });
    cronk.webhooks.failNext(2, "drop");
    await ok("POST", `${hooks}/${id}/test`, ada);
    await cronk.deliverWebhooks();
    // Cronk was down for two days: the retry it finds due on return is the last.
    cronk.clock.advance(2 * 24 * 60 * 60_000);
    await cronk.deliverWebhooks();
    const [delivery] = await ok("GET", `${hooks}/${id}/deliveries`, ada);
    expect(delivery).toMatchObject({ state: "failed", statusCode: null, error: expect.any(String) });
    expect(delivery.attempts).toHaveLength(2);
    expect((await ok("GET", `${hooks}/${id}`, ada)).failing).toBe(true);
  });

  test("a failing webhook's next successful delivery, such as Send test, clears failing", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Receiver", url: cronk.webhooks.url });
    cronk.webhooks.failNext(2, 500);
    await ok("POST", `${hooks}/${id}/test`, ada);
    await cronk.deliverWebhooks();
    cronk.clock.advance(24 * 60 * 60_000);
    await cronk.deliverWebhooks();
    expect((await ok("GET", `${hooks}/${id}`, ada)).failing).toBe(true);

    // A test that fails once more and is retried leaves it failing until the retry succeeds.
    cronk.webhooks.failNext(1, 500);
    await ok("POST", `${hooks}/${id}/test`, ada);
    await cronk.deliverWebhooks();
    expect((await ok("GET", `${hooks}/${id}`, ada)).failing).toBe(true);
    cronk.clock.advance(30_000);
    await cronk.deliverWebhooks();
    expect((await ok("GET", `${hooks}/${id}`, ada)).failing).toBe(false);
    expect((await ok("GET", `${hooks}/${id}/deliveries`, ada)).map((d: { state: string }) => d.state)).toEqual(["delivered", "failed"]);
  });

  test("a delivery still being retried is kept beyond the last 20", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Receiver", url: cronk.webhooks.url });
    cronk.webhooks.failNext(1, 500);
    const retried = (await ok("POST", `${hooks}/${id}/test`, ada)).id;
    await cronk.deliverWebhooks();
    for (let i = 0; i < 20; i++) {
      cronk.clock.advance(1000);
      await ok("POST", `${hooks}/${id}/test`, ada);
    }
    await cronk.deliverWebhooks();
    cronk.clock.advance(30_000);
    await cronk.deliverWebhooks();
    expect(cronk.webhooks.received.filter((r) => r.headers["webhook-id"] === retried)).toHaveLength(2);
    expect((await ok("GET", `${hooks}/${id}/deliveries`, ada)).every((d: { state: string }) => d.state === "delivered")).toBe(true);
  });

  test("only the last 20 deliveries of a webhook are kept", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Receiver", url: cronk.webhooks.url });
    const sent: string[] = [];
    for (let i = 0; i < 21; i++) {
      cronk.clock.advance(1000);
      sent.push((await ok("POST", `${hooks}/${id}/test`, ada)).id);
      if (i % 5 === 0) await cronk.deliverWebhooks();
    }
    await cronk.deliverWebhooks();
    const kept = await ok("GET", `${hooks}/${id}/deliveries`, ada);
    expect(kept.map((d: { id: string }) => d.id)).toEqual(sent.slice(1).reverse());
    expect(kept.every((d: { state: string }) => d.state === "delivered")).toBe(true);
  });

  test("a removed webhook's pending deliveries are never sent", async () => {
    const { ada, hooks } = await adasWorkspace();
    const { id } = await ok("POST", hooks, ada, { name: "Receiver", url: cronk.webhooks.url });
    await ok("POST", `${hooks}/${id}/test`, ada);
    await ok("DELETE", `${hooks}/${id}`, ada);
    await cronk.deliverWebhooks();
    expect(cronk.webhooks.received).toEqual([]);
  });

  test("a User removed from the Workspace loses their webhooks there, and nothing more reaches them", async () => {
    const { ada, hooks, workspace } = await adasWorkspace();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const { id } = await ok("POST", hooks, { cookie: bea.cookie }, { name: "Bea's", url: cronk.webhooks.url });
    await ok("POST", `${hooks}/${id}/test`, { cookie: bea.cookie });
    await ok("DELETE", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, ada);
    await cronk.deliverWebhooks();
    expect(cronk.webhooks.received).toEqual([]);

    // Rejoining doesn't bring them back.
    const { link } = await ok("POST", `/api/workspaces/${workspace.id}/members`, ada, { email: "bea@example.com" });
    await ok("POST", "/api/links/use", {}, { token: new URL(link.url).hash.slice(1), password: bea.password });
    const back = { cookie: await signIn(cronk, "bea@example.com", bea.password) };
    expect(await ok("GET", hooks, back)).toEqual([]);
  });
});
