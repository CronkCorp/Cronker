import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { unzip } from "../harness/zip.js";

/**
 * Private Projects (ADR 0010) in what spans Projects: search, the export and Transcripts leave out whatever the viewer
 * can't read, as if it didn't exist.
 */

let cronk: StartedCronk;
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await cronk?.stop();
});

interface As {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: As, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  const type = response.headers.get("content-type") ?? "";
  return { status: response.status, json: type.includes("json") ? await response.json() : null };
}

async function ok(method: string, path: string, as: As, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

async function agentOf(as: As, workspaceId: string, name: string) {
  const agent = await ok("POST", `/api/workspaces/${workspaceId}/agents`, as, { name });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, as, { name: "laptop", access: "full" });
  return { ...agent, secret: secret as string, as: { headers: { authorization: `Bearer ${secret}` } } };
}

async function connect(token: string) {
  const client = new Client({ name: "cronk-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", cronk.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Uploads a Claude Code transcript as the hook does: a user's message, then a Cronk tool call for each Ticket named. */
async function uploadTranscript(sessionId: string, text: string, tickets: string[], as: As) {
  const lines = [
    { type: "user", uuid: "u-0", message: { role: "user", content: text } },
    ...tickets.map((ticket, n) => ({
      type: "assistant",
      uuid: `t-${n}`,
      message: {
        id: `m-${n}`,
        role: "assistant",
        content: [{ type: "tool_use", id: `toolu_${n}`, name: "mcp__cronk__read_ticket", input: { ticket } }],
      },
    })),
  ];
  const response = await fetch(`${cronk.url}/api/transcripts/sessions/${sessionId}`, {
    method: "PUT",
    headers: { "content-type": "application/x-ndjson", ...as.headers },
    body: lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  });
  expect(response.status).toBeLessThan(300);
  return response.json();
}

const files = [{ path: "index.html", contentBase64: Buffer.from("<p>Nothing</p>").toString("base64") }];

/**
 * Ada, the Admin, with a Project SECRET and an open Project OPEN, and Grace, Linus and Edsger, members who aren't
 * Admins. SECRET-1 has a Triage Run of Ada's Agent with its Transcript and a Report; SECRET has a Document, a Term, a
 * Decision and an Artifact; OPEN-1 and a Workspace Document are open to all. Linus's Agent, connected by hand, has
 * Transcripts naming SECRET-1 and OPEN-1, only OPEN-1, and no Ticket. Everything says "webhook".
 */
async function spanning() {
  cronk = await startCronk();
  const { workspace, user } = await setUp(cronk);
  const ada = { id: user.id, cookie: await signIn(cronk) };
  const member = async (email: string) => {
    const added = await addMember(cronk, ada.cookie, workspace.id, email);
    return { ...added, as: { cookie: added.cookie } };
  };
  const grace = await member("grace@example.com");
  const linus = await member("linus@example.com");
  const edsger = await member("edsger@example.com");
  const secret = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Secret", key: "SECRET" });
  const open = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Open", key: "OPEN" });
  const hidden = await ok("POST", `/api/projects/${secret.id}/tickets`, ada, { title: "Webhook secrets" });
  const visible = await ok("POST", `/api/projects/${open.id}/tickets`, ada, { title: "Webhook docs" });

  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const adasAgent = await agentOf(ada, workspace.id, "ada-claude");
  await ok("PATCH", `/api/agents/${adasAgent.id}`, ada, { runnerId: runner.id });
  const triage = secret.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  await ok("PATCH", `/api/tickets/${hidden.id}`, ada, { delegateId: adasAgent.id, statusId: triage });
  // The fake Runner's first Run ran in `session_1`.
  const ofRun = await uploadTranscript("session_1", "Triage the webhook secrets.", [], adasAgent.as);
  const report = await ok("POST", `/api/tickets/${hidden.id}/reports`, adasAgent.as, {
    title: "Findings",
    body: "The webhook leaks.",
  });
  const document = await ok("POST", `/api/projects/${secret.id}/documents`, ada, { title: "Webhook runbook", body: "" });
  const term = await ok("POST", `/api/projects/${secret.id}/terms`, ada, { name: "Webhook", definition: "", avoid: [] });
  const decision = await ok("POST", `/api/projects/${secret.id}/decisions`, ada, { title: "Sign webhooks", body: "" });
  const artifact = await ok("POST", `/api/projects/${secret.id}/artifacts`, ada, { title: "Webhook log", files });
  const workspaceDocument = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, {
    title: "Webhook overview",
    body: "",
  });

  const gracesAgent = await agentOf(grace.as, workspace.id, "grace-claude");
  const linusesAgent = await agentOf(linus.as, workspace.id, "linus-claude");
  const both = await uploadTranscript("by-hand-both", "Compare the webhooks.", ["SECRET-1", "OPEN-1"], linusesAgent.as);
  const openOnly = await uploadTranscript("by-hand-open", "Document the webhook.", ["OPEN-1"], linusesAgent.as);
  const unnamed = await uploadTranscript("by-hand-none", "What is a webhook?", [], linusesAgent.as);

  const makePrivate = (users = [linus.user.id, edsger.user.id]) =>
    ok("PUT", `/api/projects/${secret.id}/access`, ada, {
      visibility: "private",
      users: users.map((userId) => ({ userId, level: "write" })),
    });
  return {
    workspace,
    ada,
    grace,
    linus,
    edsger,
    secret,
    open,
    hidden,
    visible,
    adasAgent,
    gracesAgent,
    linusesAgent,
    secretIds: [hidden.id, ofRun.id, report.id, document.id, term.id, decision.id, artifact.id] as string[],
    openIds: [visible.id, workspaceDocument.id] as string[],
    transcripts: { ofRun, both, openOnly, unnamed },
    makePrivate,
  };
}

type Setting = Awaited<ReturnType<typeof spanning>>;

async function found(setting: Setting, as: As, query: Record<string, string> = { q: "webhook" }): Promise<string[]> {
  const results = await ok("GET", `/api/workspaces/${setting.workspace.id}/search?${new URLSearchParams(query)}`, as);
  return results.map((r: { id: string }) => r.id);
}

describe("search", () => {
  test("leaves out every kind of result from a private Project a User isn't listed on, and their Agent", async () => {
    const setting = await spanning();
    const { secretIds, openIds, transcripts } = setting;
    expect(await found(setting, setting.grace.as)).toEqual(expect.arrayContaining([...secretIds, ...openIds]));

    await setting.makePrivate();

    const asGrace = await found(setting, setting.grace.as);
    expect(asGrace).toEqual(expect.arrayContaining([...openIds, transcripts.openOnly.id]));
    for (const id of [...secretIds, transcripts.both.id, transcripts.unnamed.id]) expect(asGrace).not.toContain(id);
    // An Agent reads only its own Transcripts of no Run.
    const asGracesAgent = await found(setting, setting.gracesAgent.as);
    expect(asGracesAgent.sort()).toEqual([...openIds].sort());
  });

  test("keeps them for Admins, the Users it lists and their Agents", async () => {
    const setting = await spanning();
    const { secretIds, openIds, transcripts } = setting;
    await setting.makePrivate();
    const hand = [transcripts.both.id, transcripts.openOnly.id, transcripts.unnamed.id];

    // An Admin and the Agent's Owner read every Transcript of no Run; a listed User those whose Tickets they can read.
    expect((await found(setting, setting.ada)).sort()).toEqual([...secretIds, ...openIds, ...hand].sort());
    expect((await found(setting, setting.linus.as)).sort()).toEqual([...secretIds, ...openIds, ...hand].sort());
    expect((await found(setting, setting.edsger.as)).sort()).toEqual(
      [...secretIds, ...openIds, transcripts.both.id, transcripts.openOnly.id].sort(),
    );
    expect((await found(setting, setting.adasAgent.as)).sort()).toEqual([...secretIds, ...openIds].sort());
    expect((await found(setting, setting.linusesAgent.as)).sort()).toEqual([...secretIds, ...openIds, ...hand].sort());
  });

  test("filters before each kind's cap, so results a User can't read never crowd out ones they can", async () => {
    const setting = await spanning();
    for (let n = 0; n < 20; n += 1) {
      await ok("POST", `/api/projects/${setting.secret.id}/tickets`, setting.ada, { title: `A webhook ${n}` });
    }
    await setting.makePrivate();

    const tickets = await found(setting, setting.grace.as, { q: "webhook", kinds: "ticket" });
    expect(tickets).toEqual([setting.visible.id]);
  });

  test("a Project filter naming a private Project answers as not found to a User it doesn't list", async () => {
    const setting = await spanning();
    await setting.makePrivate();
    const path = `/api/workspaces/${setting.workspace.id}/search?q=webhook&project=${setting.secret.id}`;

    for (const as of [setting.grace.as, setting.gracesAgent.as]) expect((await call("GET", path, as)).status).toBe(404);
    expect((await ok("GET", path, setting.linus.as)).length).toBeGreaterThan(0);
  });

  test("over MCP leaves out what the Agent's Owner can't read", async () => {
    const setting = await spanning();
    await setting.makePrivate();
    const graces = await connect(setting.gracesAgent.secret);
    const linuses = await connect(setting.linusesAgent.secret);
    const text = async (client: Client) => {
      const result = await client.callTool({ name: "search", arguments: { query: "webhook" } });
      expect(result.isError ?? false).toBe(false);
      return (result.content as { text: string }[])[0]!.text;
    };

    const asGrace = await text(graces);
    for (const id of setting.secretIds) expect(asGrace).not.toContain(id);
    expect(asGrace).not.toContain("SECRET-");
    expect(asGrace).toContain(setting.visible.id);
    const asLinus = await text(linuses);
    for (const id of setting.secretIds) expect(asLinus).toContain(id);
  });
});

describe("the export", () => {
  test("of a private Project answers as not found to a User it doesn't list, and their Agent; the Workspace's holds none of it", async () => {
    const setting = await spanning();
    const { secret, workspace, grace, gracesAgent, linus } = setting;
    await setting.makePrivate();

    for (const as of [grace.as, gracesAgent.as]) {
      for (const path of [`/api/projects/${secret.id}/export`, `/api/projects/${secret.id}/export.zip`]) {
        expect((await call("GET", path, as)).status, path).toBe(404);
      }
      const ofWorkspace = await ok("GET", `/api/workspaces/${workspace.id}/export`, as);
      expect(ofWorkspace).toEqual(await ok("GET", `/api/workspaces/${workspace.id}/export`, setting.ada));
      expect(JSON.stringify(ofWorkspace)).not.toMatch(/Webhook|webhooks/);
      const zipped = await cronk.request("GET", `/api/workspaces/${workspace.id}/export.zip`, as);
      expect(zipped.status).toBe(200);
      const entries = unzip(Buffer.from(await zipped.arrayBuffer()));
      expect([...entries.keys()]).toEqual(["GLOSSARY.md"]);
    }
    const asLinus = await ok("GET", `/api/projects/${secret.id}/export`, linus.as);
    expect(asLinus.files.map((f: { path: string }) => f.path)).toEqual(["GLOSSARY.md", "docs/adr/0001-sign-webhooks.md"]);
  });

  test("leaves the Workspace's own knowledge out for an Agent whose Workspace Agent Access is None", async () => {
    const setting = await spanning();
    const { workspace, open, ada, gracesAgent } = setting;
    await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, { name: "Retry", definition: "Once more.", avoid: [] });
    await cronk.stage("update workspaces set agent_access = 'none' where id = $1", [workspace.id]);

    expect((await call("GET", `/api/workspaces/${workspace.id}/export`, gracesAgent.as)).status).toBe(404);
    expect((await call("GET", `/api/workspaces/${workspace.id}/export.zip`, gracesAgent.as)).status).toBe(404);
    const ofProject = await ok("GET", `/api/projects/${open.id}/export`, gracesAgent.as);
    expect(ofProject.files[0].content).not.toContain("Retry");
    const asUser = await ok("GET", `/api/projects/${open.id}/export`, setting.grace.as);
    expect(asUser.files[0].content).toContain("Retry");
  });
});

describe("Transcripts", () => {
  /** Each read of a Transcript: its own address, its entries, its Agent's list and each named Ticket's list. */
  async function reads(setting: Setting, as: As, transcript: { id: string; agent: { id: string }; tickets: { id: string }[] }) {
    const listed = async (path: string) => {
      const response = await call("GET", path, as);
      return response.status === 200 && response.json.some((t: { id: string }) => t.id === transcript.id);
    };
    return {
      address: (await call("GET", `/api/transcripts/${transcript.id}`, as)).status,
      entries: (await call("GET", `/api/transcripts/${transcript.id}/entries`, as)).status,
      onAgent: await listed(`/api/agents/${transcript.agent.id}/transcripts`),
      onTickets: await Promise.all(transcript.tickets.map((ticket) => listed(`/api/tickets/${ticket.id}/transcripts`))),
    };
  }
  const readable = (tickets: number) => ({ address: 200, entries: 200, onAgent: true, onTickets: Array(tickets).fill(true) });
  const unreadable = (tickets: number) => ({ address: 404, entries: 404, onAgent: false, onTickets: Array(tickets).fill(false) });

  test("a Run's Transcript follows its Ticket's Project", async () => {
    const setting = await spanning();
    const { ofRun } = setting.transcripts;
    expect((await call("GET", `/api/transcripts/${ofRun.id}`, setting.grace.as)).status).toBe(200);
    await setting.makePrivate();

    for (const as of [setting.grace.as, setting.gracesAgent.as]) {
      expect((await call("GET", `/api/transcripts/${ofRun.id}`, as)).status).toBe(404);
      expect((await call("GET", `/api/transcripts/${ofRun.id}/entries`, as)).status).toBe(404);
    }
    for (const as of [setting.ada, setting.adasAgent.as, setting.linus.as, setting.linusesAgent.as]) {
      expect((await call("GET", `/api/transcripts/${ofRun.id}`, as)).status).toBe(200);
    }
  });

  test("one of no Run is shown to its Agent's Owner, Admins and Users who can read every Ticket it names", async () => {
    const setting = await spanning();
    const { both, openOnly, unnamed } = setting.transcripts;
    await setting.makePrivate();

    // Ada is an Admin and Linus the Agent's Owner: they read them all.
    for (const as of [setting.ada, setting.linus.as]) {
      expect(await reads(setting, as, both)).toEqual(readable(2));
      expect(await reads(setting, as, openOnly)).toEqual(readable(1));
      expect(await reads(setting, as, unnamed)).toEqual(readable(0));
    }
    // Edsger can read both Tickets; Grace only OPEN-1, and SECRET-1's list answers not found to her.
    expect(await reads(setting, setting.edsger.as, both)).toEqual(readable(2));
    expect(await reads(setting, setting.grace.as, both)).toEqual(unreadable(2));
    expect(await reads(setting, setting.grace.as, openOnly)).toEqual(readable(1));
    // Naming no Ticket, its text can't be placed in any Project, so only its Owner and Admins read it.
    for (const as of [setting.edsger.as, setting.grace.as]) expect(await reads(setting, as, unnamed)).toEqual(unreadable(0));
  });

  test("one of no Run is read by its own Agent only, among Agents", async () => {
    const setting = await spanning();
    const { both, openOnly, unnamed } = setting.transcripts;
    await setting.makePrivate();

    expect(await reads(setting, setting.linusesAgent.as, both)).toEqual(readable(2));
    expect(await reads(setting, setting.linusesAgent.as, unnamed)).toEqual(readable(0));
    for (const as of [setting.adasAgent.as, setting.gracesAgent.as]) {
      expect((await reads(setting, as, openOnly)).address).toBe(404);
      expect((await reads(setting, as, openOnly)).onAgent).toBe(false);
    }
  });

  test("one shown again when its Project opens again", async () => {
    const setting = await spanning();
    const { both } = setting.transcripts;
    await setting.makePrivate();
    expect((await call("GET", `/api/transcripts/${both.id}`, setting.grace.as)).status).toBe(404);

    await ok("PUT", `/api/projects/${setting.secret.id}/access`, setting.ada, { visibility: "open", users: [] });
    expect(await reads(setting, setting.grace.as, both)).toEqual(readable(2));
  });
});
