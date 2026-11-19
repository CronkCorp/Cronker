import { afterEach, expect, test } from "vitest";
import { startCronk, type StartedCronk } from "./start-cronk.js";

const cronks: StartedCronk[] = [];
afterEach(async () => {
  await Promise.all(cronks.splice(0).map((cronk) => cronk.stop()));
});

/** Asks the Cronk at `url` for its OpenAPI document, which names the public address it was started with. */
async function publicAddressAt(url: string): Promise<string> {
  const response = await fetch(new URL("/api/openapi.json", url));
  expect(response.status).toBe(200);
  const openApi = (await response.json()) as { servers: { url: string }[] };
  return openApi.servers[0]?.url ?? "";
}

/** Starts `count` Cronks at once, keeping each that started for `afterEach` to stop, and fails if any did not. */
async function startAtOnce(count: number): Promise<void> {
  const started = await Promise.allSettled(Array.from({ length: count }, () => startCronk()));
  for (const result of started) if (result.status === "fulfilled") cronks.push(result.value);
  expect(started.filter((result) => result.status === "rejected")).toEqual([]);
}

async function expectEachAnswersAtItsOwnPublicAddress(): Promise<void> {
  expect(new Set(cronks.map((cronk) => cronk.url)).size).toBe(cronks.length);
  for (const cronk of cronks) expect(await publicAddressAt(cronk.url)).toBe(cronk.url);
}

test("many Cronks started at once each answer at their own url, which is their public address", async () => {
  await startAtOnce(12);

  await expectEachAnswersAtItsOwnPublicAddress();
});

test("many Cronks upgraded at once each answer at their new url, which is their public address", async () => {
  await startAtOnce(6);
  const upgraded = await Promise.allSettled(cronks.map((cronk) => cronk.upgrade()));
  expect(upgraded.filter((result) => result.status === "rejected")).toEqual([]);

  await expectEachAnswersAtItsOwnPublicAddress();
});
