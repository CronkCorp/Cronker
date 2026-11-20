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

/** Ada's Workspace with a Project CRONK. */
async function workspaceWithProject() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  return { workspace, ada, project };
}

/**
 * Ada's Workspace with a Project CRONK and a Ticket CRONK-1 her Agent `claude-max` is running a Triage Run on, through
 * her fake Runner, so the Agent may write Reports on it.
 */
async function workspaceWithRun() {
  const { workspace, ada, project } = await workspaceWithProject();
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, ada, project, ticket, agent, asAgent };
}

/**
 * Uploads a Claude Code transcript of the session as the Transcript hook does, its lines alternating the user's and
 * the assistant's messages. The fake Runner's first Run ran in `session_1`.
 */
async function uploadTranscript(sessionId: string, messages: string[], as: As) {
  const lines = messages.map((text, n) =>
    n % 2 === 0
      ? { type: "user", uuid: `u-${n}`, message: { role: "user", content: text } }
      : { type: "assistant", uuid: `a-${n}`, message: { id: `m-${n}`, role: "assistant", content: [{ type: "text", text }] } },
  );
  const response = await fetch(`${cronk.url}/api/transcripts/sessions/${sessionId}`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", ...as.headers },
    body: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  });
  expect(response.status).toBeLessThan(300);
  return response.json();
}

function search(workspaceId: string, as: As, query: Record<string, string>) {
  return ok("GET", `/api/workspaces/${workspaceId}/search?${new URLSearchParams(query)}`, as);
}

describe("Search", () => {
  test("a search finds a Ticket by a word's stem", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, {
      title: "Labels vanish",
      description: "Merging a branch loses its labels.",
    });
    await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Unrelated", description: "Nothing here." });

    const results = await search(workspace.id, ada, { q: "merged" });

    expect(results).toEqual([
      {
        kind: "ticket",
        id: ticket.id,
        title: "Labels vanish",
        projectId: project.id,
        ticketKey: "CRONK-1",
        snippet: [
          { text: "Merging", match: true },
          { text: " a branch loses its labels.", match: false },
        ],
      },
    ]);
  });

  test("a search finds Documents, Reports, Terms and Decisions by a word's stem, in a Project and the Workspace", async () => {
    const { workspace, ada, project, ticket, asAgent } = await workspaceWithRun();
    const document = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, {
      title: "Onboarding",
      body: "How we deploy releases.",
    });
    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, {
      title: "Findings",
      body: "The deployment script skips migrations.",
    });
    const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, {
      name: "Release",
      definition: "A deployed version.",
      avoid: [],
    });
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, {
      title: "Deploy on Fridays",
      body: "We deploy weekly.",
    });
    await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Style", body: "Nothing to see." });

    const results = await search(workspace.id, ada, { q: "deploying" });

    expect(results.map((r: { kind: string; id: string }) => [r.kind, r.id]).sort()).toEqual(
      [
        ["decision", decision.id],
        ["document", document.id],
        ["report", report.id],
        ["term", term.id],
      ].sort(),
    );
    expect(results.find((r: { id: string }) => r.id === report.id)).toEqual({
      kind: "report",
      id: report.id,
      title: "Findings",
      projectId: project.id,
      ticketKey: "CRONK-1",
      snippet: [
        { text: "The ", match: false },
        { text: "deployment", match: true },
        { text: " script skips migrations.", match: false },
      ],
    });
    expect(results.find((r: { id: string }) => r.id === term.id)).toEqual({
      kind: "term",
      id: term.id,
      title: "Release",
      projectId: project.id,
      ticketKey: null,
      snippet: [
        { text: "A ", match: false },
        { text: "deployed", match: true },
        { text: " version.", match: false },
      ],
    });
    expect(results.find((r: { id: string }) => r.id === document.id)).toEqual(
      expect.objectContaining({ kind: "document", title: "Onboarding", projectId: null, ticketKey: null }),
    );
  });

  test("a search finds a Run's Transcript by the text of its entries, kept with the Run's Ticket and Project", async () => {
    const { workspace, ada, project, asAgent } = await workspaceWithRun();
    const transcript = await uploadTranscript(
      "session_1",
      ["Triage CRONK-1.", "The webhook fires before the deploy finishes, so GitHub retries it."],
      asAgent,
    );

    const results = await search(workspace.id, ada, { q: "deploying" });

    expect(results).toEqual([
      {
        kind: "transcript",
        id: transcript.id,
        title: "Transcript of the Triage Run",
        projectId: project.id,
        ticketKey: "CRONK-1",
        snippet: [
          { text: "The webhook fires before the ", match: false },
          { text: "deploy", match: true },
          { text: " finishes, so GitHub retries it.", match: false },
        ],
      },
    ]);
  });

  test("a Transcript of no Run is the Workspace's, left out under a Project filter", async () => {
    const { workspace, ada, project, agent, asAgent } = await workspaceWithRun();
    const ofRun = await uploadTranscript("session_1", ["Triage CRONK-1.", "The webhook retries."], asAgent);
    const own = await uploadTranscript("session_by_hand", ["Why does the webhook retry?"], asAgent);

    const all = await search(workspace.id, ada, { q: "webhook" });
    const inProject = await search(workspace.id, ada, { q: "webhook", project: project.id });
    const onlyTranscripts = await search(workspace.id, ada, { q: "webhook", kinds: "transcript" });

    expect(all.find((r: { id: string }) => r.id === own.id)).toEqual({
      kind: "transcript",
      id: own.id,
      title: `Transcript of a ${agent.name} session`,
      projectId: null,
      ticketKey: null,
      snippet: [
        { text: "Why does the ", match: false },
        { text: "webhook", match: true },
        { text: " retry?", match: false },
      ],
    });
    expect(inProject.map((r: { id: string }) => r.id)).toEqual([ofRun.id]);
    expect(onlyTranscripts.map((r: { id: string }) => r.id).sort()).toEqual([ofRun.id, own.id].sort());
  });

  test("a Transcript is found by its latest upload only", async () => {
    const { workspace, ada, asAgent } = await workspaceWithRun();
    const transcript = await uploadTranscript("session_1", ["Triage CRONK-1.", "The webhook retries."], asAgent);
    const ids = async (q: string) => ((await search(workspace.id, ada, { q })) as { id: string }[]).map((r) => r.id);
    expect(await ids("webhook")).toEqual([transcript.id]);

    await uploadTranscript("session_1", ["Triage CRONK-1.", "The cache is stale."], asAgent);
    expect(await ids("webhook")).toEqual([]);
    expect(await ids("cache")).toEqual([transcript.id]);
  });

  test("a quoted phrase matches only its words in order, `or` either word, and `-word` leaves out what has it", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    const create = (title: string, description: string) =>
      ok("POST", `/api/projects/${project.id}/tickets`, ada, { title, description });
    const inOrder = await create("Crash", "The board crashes when a column is empty.");
    const apart = await create("Slow", "An empty board loads its column slowly.");
    const other = await create("Typo", "A typo in the inbox.");
    const titles = async (q: string) =>
      ((await search(workspace.id, ada, { q })) as { title: string }[]).map((r) => r.title).sort();

    expect(await titles('"column is empty"')).toEqual([inOrder.title]);
    expect(await titles("column empty")).toEqual([inOrder.title, apart.title].sort());
    expect(await titles("crash or typo")).toEqual([inOrder.title, other.title].sort());
    expect(await titles("board -crashes")).toEqual([apart.title]);
  });

  test("the Project filter narrows results to that Project's, and `kinds` to those kinds", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Website", key: "WEB" });
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Cache the board" });
    const otherTicket = await ok("POST", `/api/projects/${other.id}/tickets`, ada, { title: "Cache the pages" });
    const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Cache", definition: "Kept.", avoid: [] });
    const workspaceDocument = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Caching" });
    const ids = async (query: Record<string, string>) =>
      ((await search(workspace.id, ada, query)) as { id: string }[]).map((r) => r.id).sort();

    expect(await ids({ q: "cache" })).toEqual([ticket.id, otherTicket.id, term.id, workspaceDocument.id].sort());
    expect(await ids({ q: "cache", project: project.id })).toEqual([ticket.id, term.id].sort());
    expect(await ids({ q: "cache", kinds: "ticket" })).toEqual([ticket.id, otherTicket.id].sort());
    expect(await ids({ q: "cache", kinds: "term,document" })).toEqual([term.id, workspaceDocument.id].sort());
    expect(await ids({ q: "cache", project: other.id, kinds: "ticket" })).toEqual([otherTicket.id]);
  });

  test("a Project filter naming no Project of the Workspace, or an unknown kind, is refused", async () => {
    const { workspace, ada } = await workspaceWithProject();
    const elsewhere = await ok("POST", "/api/workspaces", ada, { name: "Elsewhere" });
    const foreign = await ok("POST", `/api/workspaces/${elsewhere.id}/projects`, ada, { name: "Foreign", key: "FOR" });
    const path = (query: Record<string, string>) => `/api/workspaces/${workspace.id}/search?${new URLSearchParams(query)}`;

    const unknownProject = await call("GET", path({ q: "x", project: foreign.id }), ada);
    const unknownKind = await call("GET", path({ q: "x", kinds: "ticket,page" }), ada);

    expect(unknownProject.status).toBe(404);
    expect(unknownProject.json.error.code).toBe("not_found");
    expect(unknownKind.status).toBe(400);
  });

  test("nothing from another Workspace is returned, and a Workspace out of view answers not found", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    const elsewhere = await ok("POST", "/api/workspaces", ada, { name: "Elsewhere" });
    const foreign = await ok("POST", `/api/workspaces/${elsewhere.id}/projects`, ada, { name: "Foreign", key: "FOR" });
    await ok("POST", `/api/projects/${foreign.id}/tickets`, ada, { title: "Secret rollout" });
    await ok("POST", `/api/workspaces/${elsewhere.id}/documents`, ada, { title: "Rollout plan" });
    await ok("POST", `/api/projects/${foreign.id}/terms`, ada, { name: "Rollout", definition: "Secret.", avoid: [] });
    await ok("POST", `/api/projects/${foreign.id}/decisions`, ada, { title: "Roll out slowly" });
    const mine = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Rollout checklist" });
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "read" });
    const asAgent = { headers: { authorization: `Bearer ${secret}` } };

    for (const as of [ada, { cookie: bea.cookie }, asAgent]) {
      const results = await search(workspace.id, as, { q: "rollout" });
      expect(results.map((r: { id: string }) => r.id)).toEqual([mine.id]);
    }
    for (const as of [{ cookie: bea.cookie }, asAgent]) {
      const refused = await call("GET", `/api/workspaces/${elsewhere.id}/search?q=rollout`, as);
      expect(refused.status).toBe(404);
    }
  });

  test("results come best first: a match in a title above one only in the text beneath it", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    const inText = await ok("POST", `/api/projects/${project.id}/tickets`, ada, {
      title: "Flaky test",
      description: "Fails when the webhook retries.",
    });
    const inTitle = await ok("POST", `/api/projects/${project.id}/tickets`, ada, {
      title: "Webhook retries twice",
      description: "Seen on Mondays. ".repeat(30),
    });

    const results = await search(workspace.id, ada, { q: "webhook" });

    expect(results.map((r: { id: string }) => r.id)).toEqual([inTitle.id, inText.id]);
    expect(results[0].snippet).toEqual([
      { text: "Webhook", match: true },
      { text: " retries twice", match: false },
    ]);
  });

  test("Transcripts come after every other kind, however well they match", async () => {
    const { workspace, ada, project, asAgent } = await workspaceWithRun();
    // The Transcript has every alternative and the Ticket one, so by how well they match the Transcript would lead.
    const transcript = await uploadTranscript(
      "session_1",
      ["Triage CRONK-1.", "The webhook retries the deploy of the build, then the cache, the queue and the worker fail."],
      asAgent,
    );
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, {
      title: "Flaky test",
      description: "Seen when the webhook fires.",
    });

    const results = await search(workspace.id, ada, { q: "webhook or retry or deploy or build or cache or queue or worker or fail" });

    expect(results.map((r: { id: string }) => r.id)).toEqual([ticket.id, transcript.id]);
  });

  test("each kind gives at most its best 20 results", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    for (let n = 1; n <= 21; n++) {
      await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: `Flaky test ${n}` });
    }
    const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Flaky", definition: "Fails at times.", avoid: [] });

    const results = (await search(workspace.id, ada, { q: "flaky" })) as { kind: string; id: string }[];

    expect(results.filter((r) => r.kind === "ticket")).toHaveLength(20);
    expect(results.filter((r) => r.kind === "term").map((r) => r.id)).toEqual([term.id]);
  });

  test("the snippet marks the words that matched in the text, even when some matched only the title", async () => {
    const { workspace, ada, project } = await workspaceWithProject();
    await ok("POST", `/api/projects/${project.id}/tickets`, ada, {
      title: "Board breaks",
      description: `It crashes when a column is empty.${" Then nothing else happens.".repeat(20)}`,
    });
    await ok("POST", `/api/projects/${project.id}/terms`, ada, {
      name: "Ticket",
      definition: "A unit of work.",
      avoid: ["Issue", "task"],
    });

    const [ticket] = await search(workspace.id, ada, { q: "board crash" });
    const [term] = await search(workspace.id, ada, { q: "issues" });

    expect(ticket.snippet).toEqual([
      { text: "It ", match: false },
      { text: "crashes", match: true },
      { text: " when a column is empty. Then nothing else happens. Then nothing else happens", match: false },
    ]);
    expect(term.snippet).toEqual([
      { text: "A unit of work. Avoid: ", match: false },
      { text: "Issue", match: true },
      { text: ", task", match: false },
    ]);
  });
});
