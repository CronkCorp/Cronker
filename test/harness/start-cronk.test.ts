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
  const document = (await response.json()) as { servers: { url: string }[] };
  return document.servers[0]?.url ?? "";
}

test("many Cronks started at once each answer at their own url, which is their public address", async () => {
  const started = await Promise.allSettled(Array.from({ length: 12 }, () => startCronk()));
  for (const result of started) if (result.status === "fulfilled") cronks.push(result.value);
  expect(started.filter((result) => result.status === "rejected")).toEqual([]);

  expect(new Set(cronks.map((cronk) => cronk.url)).size).toBe(cronks.length);
  for (const cronk of cronks) expect(await publicAddressAt(cronk.url)).toBe(cronk.url);
});

test("many Cronks upgraded at once each answer at their new url, which is their public address", async () => {
  cronks.push(...(await Promise.all(Array.from({ length: 6 }, () => startCronk()))));
  const upgraded = await Promise.allSettled(cronks.map((cronk) => cronk.upgrade()));
  expect(upgraded.filter((result) => result.status === "rejected")).toEqual([]);

  expect(new Set(cronks.map((cronk) => cronk.url)).size).toBe(cronks.length);
  for (const cronk of cronks) expect(await publicAddressAt(cronk.url)).toBe(cronk.url);
});
