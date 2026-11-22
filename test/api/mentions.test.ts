import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Mentions (CRONK-11, CRONK-12): every Markdown text, a Ticket's description, a Comment, a Document, a Report, a
 * Term's definition and a Decision's body, links the Ticket and Decision keys it mentions outside code and links, and
 * each Ticket and Decision lists the texts mentioning it under Mentioned in; both only as far as the reader may read.
 */

let cronk: StartedCronk;
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

/** Ada with a Project CRONK holding CRONK-1, the Ticket the texts mention. */
async function workspaceWithTicket() {
  cronk = await startCronk();
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const target = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "The one mentioned" });
  return { workspace, user, ada, project, target };
}

type Setting = Awaited<ReturnType<typeof workspaceWithTicket>>;

/** A Run of an Agent on a Ticket of the Project, for writing a Report. */
async function runningRun({ workspace, ada, project }: Setting) {
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Investigate" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
  return { ticket, asAgent: { headers: { authorization: `Bearer ${secret}` } } };
}

const mentionOf = (target: { id: string }, text = "CRONK-1") => ({
  kind: "ticket",
  text,
  key: "CRONK-1",
  ticketId: target.id,
});

const mentionedIn = async (as: As, ticketId: string) => (await ok("GET", `/api/tickets/${ticketId}`, as)).mentionedIn;

/**
 * Each kind of text: writing it with the Markdown given, then reading it back, through the API that shows it, as the
 * response and later read show it.
 */
const kinds = {
  ticket: {
    async write(s: Setting, markdown: string) {
      const ticket = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Mentions", description: markdown });
      return { written: ticket, read: () => ok("GET", `/api/tickets/${ticket.id}`, s.ada) };
    },
    async edit(s: Setting, id: string, markdown: string) {
      return ok("PATCH", `/api/tickets/${id}`, s.ada, { description: markdown });
    },
  },
  comment: {
    async write(s: Setting, markdown: string) {
      const comment = await ok("POST", `/api/tickets/${s.target.id}/comments`, s.ada, { body: markdown });
      const read = async () =>
        (await ok("GET", `/api/tickets/${s.target.id}/comments`, s.ada)).find((c: { id: string }) => c.id === comment.id);
      return { written: comment, read };
    },
    edit: undefined,
  },
  document: {
    async write(s: Setting, markdown: string) {
      const document = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Notes", body: markdown });
      return { written: document, read: () => ok("GET", `/api/documents/${document.id}`, s.ada) };
    },
    async edit(s: Setting, id: string, markdown: string) {
      const { version } = await ok("GET", `/api/documents/${id}`, s.ada);
      return ok("PATCH", `/api/documents/${id}`, s.ada, { baseVersion: version.number, body: markdown });
    },
  },
  report: {
    async write(s: Setting, markdown: string) {
      const { ticket, asAgent } = await runningRun(s);
      const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, { title: "Findings", body: markdown });
      const read = async () =>
        (await ok("GET", `/api/tickets/${ticket.id}/reports`, s.ada)).find((r: { id: string }) => r.id === report.id);
      return { written: report, read };
    },
    async edit(s: Setting, id: string, markdown: string) {
      const { version } = await ok("GET", `/api/documents/${id}`, s.ada);
      return ok("PATCH", `/api/documents/${id}`, s.ada, { baseVersion: version.number, body: markdown });
    },
  },
  term: {
    async write(s: Setting, markdown: string) {
      const term = await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name: "Run", definition: markdown });
      return { written: term, read: () => ok("GET", `/api/terms/${term.id}`, s.ada) };
    },
    async edit(s: Setting, id: string, markdown: string) {
      const { version } = await ok("GET", `/api/terms/${id}`, s.ada);
      return ok("PATCH", `/api/terms/${id}`, s.ada, { baseVersion: version.number, definition: markdown });
    },
  },
  decision: {
    async write(s: Setting, markdown: string) {
      const decision = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Use Postgres", body: markdown });
      return { written: decision, read: () => ok("GET", `/api/decisions/${decision.id}`, s.ada) };
    },
    async edit(s: Setting, id: string, markdown: string) {
      const { version } = await ok("GET", `/api/decisions/${id}`, s.ada);
      return ok("PATCH", `/api/decisions/${id}`, s.ada, { baseVersion: version.number, body: markdown });
    },
  },
};

describe("Ticket Mentions in each kind of text", () => {
  test.each(Object.keys(kinds) as (keyof typeof kinds)[])(
    "a %s links the Ticket keys it mentions, whatever their case, and its Ticket lists it under Mentioned in",
    async (kind) => {
      const s = await workspaceWithTicket();
      const ops = await ok("POST", `/api/workspaces/${s.workspace.id}/projects`, s.ada, { name: "Operations", key: "OPS" });
      const opsOne = await ok("POST", `/api/projects/${ops.id}/tickets`, s.ada, { title: "Ops one" });

      const { written, read } = await kinds[kind].write(
        s,
        "After CRONK-1 and ops-1, again CRONK-1; not CRONK-99, NOPE-1, XCRONK-1x or CRONK-1x.",
      );

      const expected = [mentionOf(s.target), { kind: "ticket", text: "ops-1", key: "OPS-1", ticketId: opsOne.id }];
      expect(written.mentions).toEqual(expected);
      expect((await read()).mentions).toEqual(expected);
      expect((await mentionedIn(s.ada, s.target.id)).map((t: { kind: string; id: string }) => [t.kind, t.id])).toEqual([
        [kind, written.id],
      ]);
      expect((await mentionedIn(s.ada, opsOne.id)).map((t: { id: string }) => t.id)).toEqual([written.id]);
    },
  );

  test.each(Object.keys(kinds).filter((kind) => kinds[kind as keyof typeof kinds].edit) as (keyof typeof kinds)[])(
    "saving a %s again indexes it as it now reads",
    async (kind) => {
      const s = await workspaceWithTicket();
      const other = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Other" });
      const { written, read } = await kinds[kind].write(s, "About CRONK-1.");

      const edited = await kinds[kind].edit!(s, written.id, `Now about ${other.key} only.`);

      const now = [{ kind: "ticket", text: other.key, key: other.key, ticketId: other.id }];
      expect(edited.mentions).toEqual(now);
      expect((await read()).mentions).toEqual(now);
      expect(await mentionedIn(s.ada, s.target.id)).toEqual([]);
      expect((await mentionedIn(s.ada, other.id)).map((t: { id: string }) => t.id)).toEqual([written.id]);
    },
  );

  test("Mentioned in says what links to each text, most recently saved first, leaving out the Ticket's own description", async () => {
    const s = await workspaceWithTicket();
    await ok("PATCH", `/api/tickets/${s.target.id}`, s.ada, { description: "I am CRONK-1." });
    const ticket = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Follow-up", description: "After CRONK-1." });
    const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, s.ada, { body: "Needs CRONK-1 first." });
    const document = await ok("POST", `/api/workspaces/${s.workspace.id}/documents`, s.ada, { title: "Plan", body: "CRONK-1" });
    const term = await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name: "Lane", definition: "See CRONK-1." });
    const decision = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Lanes", body: "Per CRONK-1." });

    const ref = { id: ticket.id, projectId: s.project.id, key: "CRONK-2", title: "Follow-up" };
    expect(await mentionedIn(s.ada, s.target.id)).toEqual([
      { kind: "decision", id: decision.id, projectId: s.project.id, title: "Lanes", ticket: null, slug: null, number: 1 },
      { kind: "term", id: term.id, projectId: s.project.id, title: "Lane", ticket: null, slug: null, number: null },
      { kind: "document", id: document.id, projectId: null, title: "Plan", ticket: null, slug: document.slug, number: null },
      { kind: "comment", id: comment.id, projectId: s.project.id, title: "Follow-up", ticket: ref, slug: null, number: null },
      { kind: "ticket", id: ticket.id, projectId: s.project.id, title: "Follow-up", ticket: ref, slug: null, number: null },
    ]);
    // Its own description still links the key.
    expect((await ok("GET", `/api/tickets/${s.target.id}`, s.ada)).mentions).toEqual([mentionOf(s.target)]);
  });

  test("a Report under Mentioned in names its Ticket and slug", async () => {
    const s = await workspaceWithTicket();
    const { ticket, asAgent } = await runningRun(s);
    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, { title: "Findings", body: "CRONK-1." });

    expect(await mentionedIn(s.ada, s.target.id)).toEqual([
      {
        kind: "report",
        id: report.id,
        projectId: s.project.id,
        title: "Findings",
        ticket: { id: ticket.id, projectId: s.project.id, key: ticket.key, title: "Investigate" },
        slug: report.slug,
        number: null,
      },
    ]);
  });

  test("Terms listed in a glossary carry their Mentions", async () => {
    const s = await workspaceWithTicket();
    await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name: "Lane", definition: "See CRONK-1." });

    for (const path of [`/api/projects/${s.project.id}/terms`, `/api/projects/${s.project.id}/glossary`]) {
      expect((await ok("GET", path, s.ada)).map((t: { mentions: unknown }) => t.mentions), path).toEqual([
        [mentionOf(s.target)],
      ]);
    }
  });
});

describe("what isn't a Mention", () => {
  test("keys in code spans, code blocks, raw HTML, links and link definitions stay plain text", async () => {
    const s = await workspaceWithTicket();
    const markdown = [
      "Run `CRONK-1` here, see [CRONK-1](https://example.com/CRONK-1), <https://example.com/CRONK-1> and [ref][CRONK-1].",
      "",
      "```",
      "CRONK-1",
      "```",
      "",
      "    CRONK-1 indented",
      "",
      "<div>CRONK-1</div>",
      "",
      "[CRONK-1]: https://example.com",
    ].join("\n");

    for (const kind of Object.keys(kinds) as (keyof typeof kinds)[]) {
      const { written } = await kinds[kind].write(s, markdown);
      expect(written.mentions, kind).toEqual([]);
    }
    expect(await mentionedIn(s.ada, s.target.id)).toEqual([]);

    const { written } = await kinds.document.write(s, "But *CRONK-1* in emphasis, a **CRONK-1** and > CRONK-1 are.");
    expect(written.mentions).toEqual([mentionOf(s.target)]);
  });

  test("a key naming no Ticket stays plain text until a Ticket takes it, and a deleted text drops out of Mentioned in", async () => {
    const s = await workspaceWithTicket();
    const document = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Plan", body: "Then CRONK-2." });
    expect(document.mentions).toEqual([]);

    const later = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Later" });

    expect((await ok("GET", `/api/documents/${document.id}`, s.ada)).mentions).toEqual([
      { kind: "ticket", text: "CRONK-2", key: "CRONK-2", ticketId: later.id },
    ]);
    expect((await mentionedIn(s.ada, later.id)).map((t: { id: string }) => t.id)).toEqual([document.id]);

    await ok("DELETE", `/api/documents/${document.id}`, s.ada);
    const term = await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name: "Lane", definition: "CRONK-2" });
    await ok("DELETE", `/api/terms/${term.id}`, s.ada);
    expect(await mentionedIn(s.ada, later.id)).toEqual([]);
  });
});

/** Ada's Workspace with a Workspace Decision D1 and the Project's Decision CRONK-D1, the Decisions the texts mention. */
async function workspaceWithDecisions() {
  const s = await workspaceWithTicket();
  const own = await ok("POST", `/api/workspaces/${s.workspace.id}/decisions`, s.ada, { title: "Write it down", body: "" });
  const projects = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Use Postgres", body: "" });
  return { ...s, own, projects };
}

const decisionMention = (decision: { id: string; projectId: string | null; number: number }, text: string, key: string) => ({
  kind: "decision",
  text,
  key,
  decisionId: decision.id,
  projectId: decision.projectId,
  number: decision.number,
});

const decisionMentionedIn = async (as: As, decisionId: string) =>
  (await ok("GET", `/api/decisions/${decisionId}`, as)).mentionedIn;

describe("Decision Mentions in each kind of text", () => {
  test.each(Object.keys(kinds) as (keyof typeof kinds)[])(
    "a %s links a Project's and the Workspace's Decision keys, whatever their case, and each Decision lists it under Mentioned in",
    async (kind) => {
      const s = await workspaceWithDecisions();

      const { written, read } = await kinds[kind].write(
        s,
        "Per cronk-d1 and D1, again CRONK-D1 and d1, with CRONK-1; not CRONK-D99, D99, NOPE-D1, XD1, D1x, D1-1 or CRONK-D1x.",
      );

      const expected = [
        decisionMention(s.projects, "cronk-d1", "CRONK-D1"),
        decisionMention(s.own, "D1", "D1"),
        decisionMention(s.projects, "CRONK-D1", "CRONK-D1"),
        decisionMention(s.own, "d1", "D1"),
        mentionOf(s.target),
      ];
      expect(written.mentions).toEqual(expected);
      expect((await read()).mentions).toEqual(expected);
      for (const decision of [s.projects, s.own]) {
        expect((await decisionMentionedIn(s.ada, decision.id)).map((t: { kind: string; id: string }) => [t.kind, t.id])).toEqual([
          [kind, written.id],
        ]);
      }
      expect((await mentionedIn(s.ada, s.target.id)).map((t: { id: string }) => t.id)).toEqual([written.id]);
    },
  );

  test.each(Object.keys(kinds).filter((kind) => kinds[kind as keyof typeof kinds].edit) as (keyof typeof kinds)[])(
    "saving a %s again indexes its Decision keys as it now reads",
    async (kind) => {
      const s = await workspaceWithDecisions();
      const { written, read } = await kinds[kind].write(s, "About CRONK-D1.");

      const edited = await kinds[kind].edit!(s, written.id, "Now about D1 only.");

      const now = [decisionMention(s.own, "D1", "D1")];
      expect(edited.mentions).toEqual(now);
      expect((await read()).mentions).toEqual(now);
      expect(await decisionMentionedIn(s.ada, s.projects.id)).toEqual([]);
      expect((await decisionMentionedIn(s.ada, s.own.id)).map((t: { id: string }) => t.id)).toEqual([written.id]);
    },
  );

  test("Mentioned in on a Decision says what links to each text, most recently saved first, leaving out its own body", async () => {
    const s = await workspaceWithDecisions();
    await ok("PATCH", `/api/decisions/${s.projects.id}`, s.ada, { baseVersion: 1, body: "I am CRONK-D1." });
    const ticket = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Follow-up", description: "Per CRONK-D1." });
    const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, s.ada, { body: "See CRONK-D1." });
    const document = await ok("POST", `/api/workspaces/${s.workspace.id}/documents`, s.ada, { title: "Plan", body: "CRONK-D1" });
    const term = await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name: "Lane", definition: "See CRONK-D1." });
    const decision = await ok("POST", `/api/workspaces/${s.workspace.id}/decisions`, s.ada, { title: "Lanes", body: "Per CRONK-D1." });

    const ref = { id: ticket.id, projectId: s.project.id, key: ticket.key, title: "Follow-up" };
    expect(await decisionMentionedIn(s.ada, s.projects.id)).toEqual([
      { kind: "decision", id: decision.id, projectId: null, title: "Lanes", ticket: null, slug: null, number: 2 },
      { kind: "term", id: term.id, projectId: s.project.id, title: "Lane", ticket: null, slug: null, number: null },
      { kind: "document", id: document.id, projectId: null, title: "Plan", ticket: null, slug: document.slug, number: null },
      { kind: "comment", id: comment.id, projectId: s.project.id, title: "Follow-up", ticket: ref, slug: null, number: null },
      { kind: "ticket", id: ticket.id, projectId: s.project.id, title: "Follow-up", ticket: ref, slug: null, number: null },
    ]);
    // Its own body still links its key.
    expect((await ok("GET", `/api/decisions/${s.projects.id}`, s.ada)).mentions).toEqual([
      decisionMention(s.projects, "CRONK-D1", "CRONK-D1"),
    ]);
  });

  test("a Decision answers with what mentions it when proposed and saved, and its summaries leave it out", async () => {
    const s = await workspaceWithDecisions();
    await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Plan", body: "CRONK-D1" });

    const edited = await ok("PATCH", `/api/decisions/${s.projects.id}`, s.ada, { baseVersion: 1, title: "Use Postgres 16" });
    expect(edited.mentionedIn.map((t: { kind: string }) => t.kind)).toEqual(["document"]);
    const created = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Later", body: "" });
    expect(created.mentionedIn).toEqual([]);
    for (const summary of await ok("GET", `/api/projects/${s.project.id}/decisions`, s.ada)) {
      expect(summary).not.toHaveProperty("mentionedIn");
    }
  });
});

describe("what isn't a Decision Mention", () => {
  test("Decision keys in code spans, code blocks, raw HTML, links and link definitions stay plain text", async () => {
    const s = await workspaceWithDecisions();
    const markdown = [
      "Run `D1` here, see [CRONK-D1](https://example.com/D1), <https://example.com/CRONK-D1> and [ref][D1].",
      "",
      "```",
      "CRONK-D1 D1",
      "```",
      "",
      "<div>D1</div>",
      "",
      "[D1]: https://example.com",
    ].join("\n");

    for (const kind of Object.keys(kinds) as (keyof typeof kinds)[]) {
      const { written } = await kinds[kind].write(s, markdown);
      expect(written.mentions, kind).toEqual([]);
    }
    expect(await decisionMentionedIn(s.ada, s.own.id)).toEqual([]);
    expect(await decisionMentionedIn(s.ada, s.projects.id)).toEqual([]);
  });

  test("a Decision key naming no Decision stays plain text until a Decision takes it", async () => {
    const s = await workspaceWithDecisions();
    const ops = await ok("POST", `/api/workspaces/${s.workspace.id}/projects`, s.ada, { name: "Operations", key: "OPS" });
    // OPS has no Decision 1, and the Workspace and CRONK no Decision 2.
    const document = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Plan", body: "OPS-D1, D2." });
    expect(document.mentions).toEqual([]);

    const opsOne = await ok("POST", `/api/projects/${ops.id}/decisions`, s.ada, { title: "Ops one", body: "" });
    const later = await ok("POST", `/api/workspaces/${s.workspace.id}/decisions`, s.ada, { title: "Later", body: "" });

    expect((await ok("GET", `/api/documents/${document.id}`, s.ada)).mentions).toEqual([
      decisionMention(opsOne, "OPS-D1", "OPS-D1"),
      decisionMention(later, "D2", "D2"),
    ]);
    expect((await decisionMentionedIn(s.ada, later.id)).map((t: { id: string }) => t.id)).toEqual([document.id]);
    expect(await decisionMentionedIn(s.ada, s.own.id)).toEqual([]);
  });
});

describe("Mentions and Access", () => {
  /** A private Project SECRET only Ada and Linus may read, next to the open CRONK; Grace may read only CRONK. */
  async function privateProject() {
    const s = await workspaceWithTicket();
    const grace = await addMember(cronk, s.ada.cookie, s.workspace.id, "grace@example.com");
    const linus = await addMember(cronk, s.ada.cookie, s.workspace.id, "linus@example.com");
    const secret = await ok("POST", `/api/workspaces/${s.workspace.id}/projects`, s.ada, { name: "Secret", key: "SECRET" });
    const hidden = await ok("POST", `/api/projects/${secret.id}/tickets`, s.ada, { title: "Hidden" });
    await ok("PUT", `/api/projects/${secret.id}/access`, s.ada, {
      visibility: "private",
      users: [{ userId: linus.user.id, level: "write" }],
    });
    return { ...s, secret, hidden, grace: { cookie: grace.cookie }, linus: { cookie: linus.cookie } };
  }

  test("a Mention of a Ticket the reader can't read stays plain text", async () => {
    const s = await privateProject();
    const ticket = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, {
      title: "Open",
      description: "Waits on SECRET-1 and CRONK-1.",
    });
    const document = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Plan", body: "SECRET-1" });

    const secretMention = { kind: "ticket", text: "SECRET-1", key: "SECRET-1", ticketId: s.hidden.id };
    for (const [who, as, mentions] of [
      ["Ada", s.ada, [secretMention, mentionOf(s.target)]],
      ["Linus", s.linus, [secretMention, mentionOf(s.target)]],
      ["Grace", s.grace, [mentionOf(s.target)]],
    ] as const) {
      expect((await ok("GET", `/api/tickets/${ticket.id}`, as)).mentions, who).toEqual(mentions);
    }
    expect((await ok("GET", `/api/documents/${document.id}`, s.grace)).mentions).toEqual([]);
    expect((await ok("GET", `/api/documents/${document.id}`, s.linus)).mentions).toEqual([secretMention]);
  });

  test("Mentioned in leaves out the texts the reader can't read", async () => {
    const s = await privateProject();
    const hiddenDoc = await ok("POST", `/api/projects/${s.secret.id}/documents`, s.ada, { title: "Hidden plan", body: "CRONK-1" });
    await ok("POST", `/api/tickets/${s.hidden.id}/comments`, s.ada, { body: "Also CRONK-1." });
    const openDoc = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Open plan", body: "CRONK-1" });

    const ids = async (as: As) => (await mentionedIn(as, s.target.id)).map((t: { kind: string }) => t.kind);
    expect(await ids(s.linus)).toEqual(["document", "comment", "document"]);
    expect(await ids(s.grace)).toEqual(["document"]);
    expect((await mentionedIn(s.grace, s.target.id))[0].id).toBe(openDoc.id);
    expect((await mentionedIn(s.ada, s.target.id)).map((t: { id: string }) => t.id)).toContain(hiddenDoc.id);
  });

  test("a Mention of a Decision the reader can't read stays plain text", async () => {
    const s = await privateProject();
    const hiddenDecision = await ok("POST", `/api/projects/${s.secret.id}/decisions`, s.ada, { title: "Hidden", body: "" });
    const document = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Plan", body: "SECRET-D1" });

    const secretMention = decisionMention(hiddenDecision, "SECRET-D1", "SECRET-D1");
    expect((await ok("GET", `/api/documents/${document.id}`, s.linus)).mentions).toEqual([secretMention]);
    expect((await ok("GET", `/api/documents/${document.id}`, s.grace)).mentions).toEqual([]);
    expect((await call("GET", `/api/decisions/${hiddenDecision.id}`, s.grace)).status).toBe(404);
  });

  test("Mentioned in on a Decision leaves out the texts the reader can't read", async () => {
    const s = await privateProject();
    const own = await ok("POST", `/api/workspaces/${s.workspace.id}/decisions`, s.ada, { title: "Write it down", body: "" });
    const hiddenDoc = await ok("POST", `/api/projects/${s.secret.id}/documents`, s.ada, { title: "Hidden plan", body: "D1" });
    await ok("POST", `/api/tickets/${s.hidden.id}/comments`, s.ada, { body: "Also d1." });
    const openDoc = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Open plan", body: "D1" });

    const kindsFor = async (as: As) => (await decisionMentionedIn(as, own.id)).map((t: { kind: string }) => t.kind);
    expect(await kindsFor(s.linus)).toEqual(["document", "comment", "document"]);
    expect(await kindsFor(s.grace)).toEqual(["document"]);
    expect((await decisionMentionedIn(s.grace, own.id))[0].id).toBe(openDoc.id);
    expect((await decisionMentionedIn(s.ada, own.id)).map((t: { id: string }) => t.id)).toContain(hiddenDoc.id);
  });
});

describe("texts written before the Mention index", () => {
  test("are indexed once on the next start", async () => {
    const s = await workspaceWithTicket();
    const ticket = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Then", description: "After CRONK-1." });
    const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, s.ada, { body: "CRONK-1 `CRONK-2`" });
    const document = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Plan", body: "v1" });
    await ok("PATCH", `/api/documents/${document.id}`, s.ada, { baseVersion: 1, body: "v2 is about CRONK-1" });
    const term = await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name: "Lane", definition: "CRONK-1" });
    const decision = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Lanes", body: "CRONK-1" });
    // As a Cronk before migration 0055 left them: no Mentions recorded, with their indexing still to do.
    await cronk.stage("delete from mentions");
    await cronk.stage("insert into pending_backfills (name) values ('mentions')");
    expect(await mentionedIn(s.ada, s.target.id)).toEqual([]);

    await cronk.upgrade();

    expect((await mentionedIn(s.ada, s.target.id)).map((t: { kind: string; id: string }) => [t.kind, t.id]).sort()).toEqual(
      [
        ["comment", comment.id],
        ["decision", decision.id],
        ["document", document.id],
        ["term", term.id],
        ["ticket", ticket.id],
      ].sort(),
    );
    expect((await ok("GET", `/api/tickets/${ticket.id}/comments`, s.ada))[0].mentions).toEqual([mentionOf(s.target)]);
  });

  test("have their Decision keys indexed once on the next start after migration 0066", async () => {
    const s = await workspaceWithDecisions();
    const ticket = await ok("POST", `/api/projects/${s.project.id}/tickets`, s.ada, { title: "Then", description: "Per D1." });
    const comment = await ok("POST", `/api/tickets/${ticket.id}/comments`, s.ada, { body: "CRONK-D1 `D1`" });
    const decision = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Lanes", body: "After D1, CRONK-1." });
    // As migration 0066 leaves a Cronk that indexed only Ticket keys: their indexing still to do.
    await cronk.stage("delete from mentions where target_kind = 'decision'");
    await cronk.stage("insert into pending_backfills (name) values ('decision-mentions')");
    expect(await decisionMentionedIn(s.ada, s.own.id)).toEqual([]);

    await cronk.upgrade();

    expect((await decisionMentionedIn(s.ada, s.own.id)).map((t: { kind: string; id: string }) => [t.kind, t.id]).sort()).toEqual(
      [
        ["decision", decision.id],
        ["ticket", ticket.id],
      ].sort(),
    );
    expect((await ok("GET", `/api/tickets/${ticket.id}/comments`, s.ada))[0].mentions).toEqual([
      decisionMention(s.projects, "CRONK-D1", "CRONK-D1"),
    ]);
    expect((await mentionedIn(s.ada, s.target.id)).map((t: { id: string }) => t.id)).toEqual([decision.id]);
  });
});

describe("Embeds", () => {
  const page = (text: string) => ({ path: "index.html", contentBase64: Buffer.from(`<h1>${text}</h1>`).toString("base64") });

  /** The setting with an Artifact of the Project at Version 2, and the Workspace's slug its address starts with. */
  async function withArtifact() {
    const s = await workspaceWithTicket();
    const workspace = await ok("GET", `/api/workspaces/${s.workspace.id}`, s.ada);
    const created = await ok("POST", `/api/projects/${s.project.id}/artifacts`, s.ada, { title: "Board prototype", files: [page("One")] });
    const latest = await ok("PATCH", `/api/artifacts/${created.id}`, s.ada, { baseVersion: 1, title: "Board", files: [page("Two")] });
    const first = await ok("GET", `/api/artifacts/${created.id}?version=1`, s.ada);
    const address = `/${workspace.slug}/artifacts/${latest.slug}`;
    return { ...s, slug: workspace.slug as string, artifact: latest, first, address };
  }

  const embedOf = (artifact: { id: string; slug: string; title: string; url: string }, text: string, version: number | null) => ({
    kind: "artifact",
    text,
    artifactId: artifact.id,
    slug: artifact.slug,
    title: artifact.title,
    version,
    url: artifact.url,
  });

  test("an Artifact's address alone in its paragraph is a Mention of the Artifact, at the Version it names or the latest", async () => {
    const s = await withArtifact();
    const absolute = `${cronk.url}${s.address}`;
    const pinned = `${cronk.url}${s.address}?version=1`;
    const byId = `${cronk.url}/artifacts/${s.artifact.id}`;
    const markdown = [absolute, "", "Before CRONK-1.", "", `<${pinned}>`, "", byId, "", `> ${s.address}`].join("\n");

    for (const kind of Object.keys(kinds) as (keyof typeof kinds)[]) {
      const { written, read } = await kinds[kind].write(s, markdown);
      const mentions = [
        mentionOf(s.target),
        embedOf(s.artifact, absolute, null),
        // Its slug is the Artifact's, from its latest title; the rest the pinned Version's.
        { ...embedOf(s.first, pinned, 1), slug: s.artifact.slug },
        embedOf(s.artifact, byId, null),
        embedOf(s.artifact, s.address, null),
      ];
      expect(written.mentions, kind).toEqual(mentions);
      expect((await read()).mentions, kind).toEqual(mentions);
    }
    // The pinned Version is the one it shows: its own title and page, not the latest's.
    expect(s.first).toMatchObject({ title: "Board prototype", version: { number: 1 } });
    expect(s.first.url).not.toBe(s.artifact.url);
  });

  test("an address with anything beside it, as a link with words, in code, or naming nothing, doesn't embed", async () => {
    const s = await withArtifact();
    const other = await ok("POST", "/api/workspaces", s.ada, { name: "Other", slug: "other" });
    const markdown = [
      `See ${s.address} for the board.`,
      "",
      `[The board](${s.address})`,
      "",
      `\`${s.address}\``,
      "",
      "```",
      s.address,
      "```",
      "",
      `${s.address}`,
      "and a second line",
      "",
      `${s.address}?version=3`,
      "",
      `${s.address}?v=1`,
      "",
      `${s.address}#top`,
      "",
      `/${other.slug}/artifacts/${s.artifact.slug}`,
      "",
      `/${s.slug}/artifacts/nothing-0000beef`,
      "",
      `/${s.slug}/documents/${s.artifact.slug}`,
    ].join("\n");
    const document = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Plan", body: markdown });
    expect(document.mentions).toEqual([]);
    expect(await call("GET", `/api/artifacts/${s.artifact.id}?version=3`, s.ada)).toMatchObject({ status: 404 });
  });

  test("an Artifact the reader can't read stays plain text, and a deleted one is no longer embedded", async () => {
    const s = await withArtifact();
    const grace = { cookie: (await addMember(cronk, s.ada.cookie, s.workspace.id, "grace@example.com")).cookie };
    const secret = await ok("POST", `/api/workspaces/${s.workspace.id}/projects`, s.ada, { name: "Secret", key: "SECRET" });
    const hidden = await ok("POST", `/api/projects/${secret.id}/artifacts`, s.ada, { title: "Hidden", files: [page("Hidden")] });
    await ok("PUT", `/api/projects/${secret.id}/access`, s.ada, { visibility: "private", users: [] });
    const hiddenAddress = `/${s.slug}/artifacts/${hidden.slug}`;
    const document = await ok("POST", `/api/workspaces/${s.workspace.id}/documents`, s.ada, {
      title: "Plan",
      body: `${hiddenAddress}\n\n${s.address}`,
    });

    expect(document.mentions).toEqual([embedOf(hidden, hiddenAddress, null), embedOf(s.artifact, s.address, null)]);
    expect((await ok("GET", `/api/documents/${document.id}`, grace)).mentions).toEqual([embedOf(s.artifact, s.address, null)]);

    await ok("DELETE", `/api/artifacts/${s.artifact.id}`, s.ada);
    expect((await ok("GET", `/api/documents/${document.id}`, s.ada)).mentions).toEqual([embedOf(hidden, hiddenAddress, null)]);
  });

  test("texts written before Embeds were indexed are indexed on the next start", async () => {
    const s = await withArtifact();
    const document = await ok("POST", `/api/projects/${s.project.id}/documents`, s.ada, { title: "Plan", body: s.address });
    // As a Cronk before migration 0057 left them: no Embeds recorded, with their indexing still to do.
    await cronk.stage("delete from mentions");
    await cronk.stage("insert into pending_backfills (name) values ('embeds')");
    expect((await ok("GET", `/api/documents/${document.id}`, s.ada)).mentions).toEqual([]);

    await cronk.upgrade();

    expect((await ok("GET", `/api/documents/${document.id}`, s.ada)).mentions).toEqual([embedOf(s.artifact, s.address, null)]);
  });
});
