import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("search from the sidebar, see results grouped by kind with highlighted snippets, narrow by Project, and open one", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const website = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
  await post(`/api/projects/${project.id}/tickets`, {
    title: "Labels vanish",
    description: "Merging a branch loses its labels.",
  });
  await post(`/api/projects/${website.id}/tickets`, { title: "Merge the footers" });
  await post(`/api/workspaces/${workspace.id}/documents`, { title: "Releasing", body: "We merge to main, then tag." });
  await post(`/api/projects/${project.id}/terms`, { name: "Merge Step", definition: "Merges a Pull Request.", avoid: [] });

  await signInInBrowser(page, cronk);
  const box = page.getByRole("navigation", { name: "Sidebar" }).getByRole("searchbox", { name: "Search" });
  await box.fill("merged");
  await box.press("Enter");

  await expect(page.getByRole("heading", { name: "Search", level: 1 })).toBeVisible();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/search?q=merged`);
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByRole("heading", { level: 2 })).toHaveText(["Tickets 2", "Documents 1", "Terms 1"]);
  const tickets = page.getByRole("region", { name: "Tickets" });
  const labelsVanish = tickets.getByRole("listitem").filter({ hasText: "Labels vanish" });
  await expect(labelsVanish.getByText("CRONK-1")).toBeVisible();
  await expect(labelsVanish.locator("mark")).toHaveText("Merging");
  await expect(page.getByRole("region", { name: "Documents" }).locator("mark")).toHaveText("merge");

  await page.getByLabel("Project").selectOption({ label: "CRONK Cronker" });
  await expect(page).toHaveURL(/\/search\?q=merged&project=/);
  await expect(results.getByRole("heading", { level: 2 })).toHaveText(["Tickets 1", "Terms 1"]);

  await page.getByRole("link", { name: /Labels vanish/ }).click();
  await expect(page.getByRole("heading", { name: "Labels vanish" })).toBeVisible();
  await expect(page).toHaveURL(`${cronk.url}/adas-workspace/tickets/CRONK-1`);
});

test("a search that finds nothing says so", async ({ page, cronk }) => {
  await setUp(cronk);
  await signInInBrowser(page, cronk);
  const box = page.getByRole("searchbox", { name: "Search" });
  await box.fill("nothing like it");
  await box.press("Enter");

  await expect(page.getByText("Nothing matches nothing like it.")).toBeVisible();
});

test("a Transcript found by its text shows after every other kind and opens its page", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const send = async (method: string, path: string, body: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await send("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await send("POST", `/api/projects/${project.id}/tickets`, { title: "Flaky webhook" });
  const runner = await send("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const created = await send("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  const agent = await send("PATCH", `/api/agents/${created.id}`, { runnerId: runner.id });
  const { secret } = await send("POST", `/api/agents/${agent.id}/tokens`, { name: "Transcript hook", access: "full" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
  await send("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id, statusId: triage });
  // The fake Runner's first Run ran in session_1; the hook uploads its transcript.
  const lines = [
    { type: "user", uuid: "u-1", message: { role: "user", content: "Triage CRONK-1." } },
    {
      type: "assistant",
      uuid: "a-1",
      message: { id: "m-1", role: "assistant", content: [{ type: "text", text: "The webhook fires before the deploy finishes." }] },
    },
  ];
  await fetch(`${cronk.url}/api/transcripts/sessions/session_1`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${secret}` },
    body: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  });

  await signInInBrowser(page, cronk);
  const box = page.getByRole("searchbox", { name: "Search" });
  await box.fill("webhook");
  await box.press("Enter");

  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByRole("heading", { level: 2 })).toHaveText(["Tickets 1", "Transcripts 1"]);
  const transcripts = page.getByRole("region", { name: "Transcripts" });
  await expect(transcripts.getByText("CRONK-1")).toBeVisible();
  await expect(transcripts.locator("mark")).toHaveText("webhook");

  await transcripts.getByRole("link", { name: /Transcript of the Triage Run/ }).click();
  await expect(page).toHaveURL(/\/adas-workspace\/transcripts\/claude-max-[0-9a-f]{8}$/);
  await expect(page.getByRole("heading", { name: "Transcript of the Triage Run", level: 1 })).toBeVisible();
});
