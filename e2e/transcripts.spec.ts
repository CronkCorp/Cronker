import { setUp } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

/** Lines of a Claude Code transcript as the hook uploads them: a Brief, a reply, a tool call and its result, a reply. */
const lines = [
  { type: "user", uuid: "u1", timestamp: "2026-01-01T09:00:00.000Z", message: { role: "user", content: "Triage CRONK-1." } },
  {
    type: "assistant",
    uuid: "a1",
    timestamp: "2026-01-01T09:00:05.000Z",
    message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Reading the Ticket first." }] },
  },
  {
    type: "assistant",
    uuid: "t1",
    timestamp: "2026-01-01T09:00:06.000Z",
    message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "x1", name: "read_ticket", input: { key: "CRONK-1" } }] },
  },
  {
    type: "user",
    uuid: "r1",
    timestamp: "2026-01-01T09:00:07.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x1", content: "CRONK-1 Make it so, in full" }] },
  },
  {
    type: "assistant",
    uuid: "a2",
    timestamp: "2026-01-01T09:00:09.000Z",
    message: { id: "m3", role: "assistant", content: [{ type: "text", text: "It is ready for Implement." }] },
  },
];

test("a Run's Transcript opens from the timeline, follows new uploads, expands a tool call and is deleted", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  await signInInBrowser(page, cronk);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Make it so" });
  const runner = await call("POST", "/api/runners", { name: "Fake", kind: "fake" });
  const agent = await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "claude-max" });
  await call("PATCH", `/api/agents/${agent.id}`, { runnerId: runner.id });
  const { secret } = await call("POST", `/api/agents/${agent.id}/tokens`, { name: "Transcript hook", access: "full" });
  await call("PATCH", `/api/tickets/${ticket.id}`, { delegateId: agent.id });
  await call("PATCH", `/api/tickets/${ticket.id}`, {
    statusId: project.statuses.find((s: { name: string }) => s.name === "Triage").id,
  });
  // The hook uploads the whole session after each of the agent's turns.
  const upload = async (count: number) => {
    const response = await fetch(`${cronk.url}/api/transcripts/sessions/session_1`, {
      method: "PUT",
      headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${secret}` },
      body: lines.slice(0, count).map((line) => JSON.stringify(line)).join("\n"),
    });
    expect(response.status).toBeLessThan(300);
  };

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  // The first upload links the Transcript on the open timeline.
  await upload(2);
  await timeline.getByRole("link", { name: "Transcript" }).click();

  await expect(page.getByRole("heading", { name: "Transcript of the Triage Run" })).toBeVisible();
  const entries = page.getByRole("list", { name: "Entries" });
  await expect(entries).toContainText("Reading the Ticket first.");
  await expect(page.getByRole("status", { name: "Live updates" })).toHaveText("Live");

  // The agent's next turn arrives while the page is open.
  await upload(5);
  await expect(entries).toContainText("It is ready for Implement.");
  const toolLine = entries.getByRole("button", { name: /read_ticket/ });
  await expect(toolLine).toHaveAttribute("aria-expanded", "false");
  await expect(entries).not.toContainText("CRONK-1 Make it so, in full");
  await toolLine.click();
  await expect(toolLine).toHaveAttribute("aria-expanded", "true");
  await expect(entries.getByRole("region", { name: "Input" })).toContainText('"key": "CRONK-1"');
  await expect(entries.getByRole("region", { name: "Result" })).toContainText("CRONK-1 Make it so, in full");

  await page.getByRole("button", { name: "More of this Transcript" }).click();
  await page.getByRole("menuitem", { name: "Delete Transcript" }).click();
  await page.getByRole("dialog", { name: "Delete the Transcript of the Triage Run?" }).getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(`${cronk.url}/tickets/${ticket.id}`);
  await expect(timeline).toContainText("Transcript deleted");
  await expect(timeline.getByRole("link", { name: "Transcript" })).toHaveCount(0);
  await expect(timeline).toContainText("deleted the Transcript of the Triage Run");
});

test("a Transcript deleted by another User while open stays shown, marked Deleted elsewhere", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  await signInInBrowser(page, cronk);
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  const call = async (method: string, path: string, body?: unknown) => cronk.request(method, path, { cookie, body });
  const agent = await (await call("POST", `/api/workspaces/${workspace.id}/agents`, { name: "laptop" })).json();
  const { secret } = await (await call("POST", `/api/agents/${agent.id}/tokens`, { name: "Transcript hook", access: "full" })).json();
  const uploaded = await fetch(`${cronk.url}/api/transcripts/sessions/laptop-session`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", authorization: `Bearer ${secret}` },
    body: lines.slice(0, 2).map((line) => JSON.stringify(line)).join("\n"),
  });
  const transcript = await uploaded.json();
  await page.goto(`${cronk.url}/transcripts/${transcript.id}`);
  await expect(page.getByRole("list", { name: "Entries" })).toContainText("Reading the Ticket first.");

  expect((await call("DELETE", `/api/transcripts/${transcript.id}`)).status).toBe(204);

  await expect(page.getByRole("note", { name: "Deleted elsewhere" })).toContainText("this Transcript's entries are gone.");
  await expect(page.getByRole("list", { name: "Entries" })).toContainText("Reading the Ticket first.");
  await expect(page.getByRole("button", { name: "More of this Transcript" })).toHaveCount(0);
});
