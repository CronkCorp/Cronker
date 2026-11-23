import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

/**
 * Comments on a whole Document (CRONK-66): Users and Agents comment on a Document as on a Ticket, with replies and
 * Attachments, filtered by Access as the Document is; the Document's read returns its threads.
 */

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

/** Attaches a file by sending its bytes as the request body, as the web client does, named in the query. */
async function attach(path: string, as: As, name: string) {
  const response = await fetch(new URL(`${path}?name=${encodeURIComponent(name)}`, cronk.url), {
    method: "POST",
    headers: { ...as.headers, ...(as.cookie ? { cookie: as.cookie } : {}), "content-type": "text/plain" },
    body: "npm test\n",
  });
  return { status: response.status, json: await response.json() };
}

/**
 * Ada's Workspace with a Project CRONK holding Ticket CRONK-1 and a Document, a Document of the Workspace's own, and
 * full and read-only tokens of her Agent `claude-max`.
 */
async function documentsAndTickets() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Try drag and drop" });
  const plan = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan", body: "One." });
  const guide = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Style guide", body: "Two." });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const readOnly = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "viewer", access: "read" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  const asReadOnly = { headers: { authorization: `Bearer ${readOnly.secret}` } };
  return { workspace, user, ada, project, ticket, plan, guide, agent, asAgent, asReadOnly };
}

describe("Comments on a Document", () => {
  test("a User and an Agent comment and reply on a Document, listed oldest first and with the Document's read", async () => {
    const { user, ada, plan, agent, asAgent } = await documentsAndTickets();

    const posted = await call("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Is step two needed?" });
    cronk.clock.advance(1000);
    const reply = await ok("POST", `/api/documents/${plan.id}/comments`, asAgent, {
      body: "Dropped it in Version 2.",
      replyToId: posted.json.id,
    });

    expect(posted).toEqual({
      status: 201,
      json: {
        id: expect.any(String),
        ticketId: null,
        artifactId: null,
        artifact: null,
        documentId: plan.id,
        document: { id: plan.id, projectId: plan.projectId, title: "Plan", slug: plan.slug },
        replyToId: null,
        body: "Is step two needed?",
        actor: { kind: "user", id: user.id, name: "ada@example.com" },
        createdAt: expect.any(String),
        mentions: [],
        attachments: [],
        questionId: null,
        sentBack: false,
        resolved: null,
        quote: null,
        quoteVersion: null,
        anchor: null,
      },
    });
    expect(reply).toEqual(
      expect.objectContaining({ replyToId: posted.json.id, actor: { kind: "agent", id: agent.id, name: "claude-max" } }),
    );
    expect(await ok("GET", `/api/documents/${plan.id}/comments`, ada)).toEqual([posted.json, reply]);
    // A slug names the Document as its id does.
    expect(await ok("GET", `/api/documents/${plan.slug}/comments`, ada)).toEqual([posted.json, reply]);
    // The Document's read carries its threads; its PATCH and its list don't.
    const read = await ok("GET", `/api/documents/${plan.id}`, ada);
    expect(read.comments).toEqual([posted.json, reply]);
    const saved = await ok("PATCH", `/api/documents/${plan.id}`, ada, { baseVersion: 1, title: "The plan" });
    expect(saved).not.toHaveProperty("comments");
    expect((await ok("GET", `/api/documents/${plan.id}/comments`, ada))[0].document.title).toBe("The plan");
  });

  test("a Workspace's own Document takes Comments too", async () => {
    const { ada, guide } = await documentsAndTickets();

    const comment = await ok("POST", `/api/documents/${guide.id}/comments`, ada, { body: "More examples, please." });

    expect(comment.document).toEqual({ id: guide.id, projectId: null, title: "Style guide", slug: guide.slug });
    expect(await ok("GET", `/api/documents/${guide.id}/comments`, ada)).toEqual([comment]);
  });

  test("a reply only goes to a Comment on the same Document", async () => {
    const { ada, ticket, plan, guide } = await documentsAndTickets();
    const onGuide = await ok("POST", `/api/documents/${guide.id}/comments`, ada, { body: "On the guide." });
    const onTicket = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "On the Ticket." });
    const onPlan = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "On the plan." });

    for (const replyToId of [onGuide.id, onTicket.id, "nope"]) {
      const refused = await call("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Reply", replyToId });
      expect(refused.status, replyToId).toBe(400);
      expect(refused.json.error).toEqual(
        expect.objectContaining({ code: "unknown_comment", message: "Replies go to a Comment on the same Document." }),
      );
    }
    const onTheTicket = await call("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Reply", replyToId: onPlan.id });
    expect(onTheTicket.status).toBe(400);
    expect(onTheTicket.json.error.code).toBe("unknown_comment");
    expect(await ok("GET", `/api/documents/${plan.id}/comments`, ada)).toEqual([onPlan]);
    // A Document's Comments stay off every Ticket's.
    expect(await ok("GET", `/api/tickets/${ticket.id}/comments`, ada)).toEqual([onTicket]);
  });

  test("an empty body and an unknown Document are refused", async () => {
    const { ada, plan } = await documentsAndTickets();

    expect((await call("POST", `/api/documents/${plan.id}/comments`, ada, { body: "  " })).status).toBe(400);
    expect((await call("POST", `/api/documents/nope/comments`, ada, { body: "Hi" })).status).toBe(404);
    expect((await call("GET", `/api/documents/nope/comments`, ada)).status).toBe(404);
  });

  test("a read-only token reads a Document's Comments but can't comment", async () => {
    const { ada, plan, asReadOnly } = await documentsAndTickets();
    const comment = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Looks good." });

    expect(await ok("GET", `/api/documents/${plan.id}/comments`, asReadOnly)).toEqual([comment]);
    const refused = await call("POST", `/api/documents/${plan.id}/comments`, asReadOnly, { body: "Hi" });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("read_only_token");
  });

  test("its author attaches files to it, which come with the Comment and can be downloaded", async () => {
    const { ada, plan, asAgent } = await documentsAndTickets();
    const comment = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "See the log." });

    const attached = await attach(`/api/comments/${comment.id}/attachments`, ada, "build.log");
    const byAnother = await attach(`/api/comments/${comment.id}/attachments`, asAgent, "other.log");

    expect(attached.status).toBe(201);
    expect(attached.json.on).toEqual({ kind: "comment", id: comment.id });
    expect(byAnother.status).toBe(403);
    expect(byAnother.json.error.code).toBe("not_comment_author");
    const [listed] = await ok("GET", `/api/documents/${plan.id}/comments`, ada);
    expect(listed.attachments).toEqual([attached.json]);
    // The Document's own Attachments are its own, not its Comments'.
    expect(await ok("GET", `/api/documents/${plan.id}/attachments`, ada)).toEqual([]);
    const download = await fetch(new URL(`/api/attachments/${attached.json.id}/content`, cronk.url), {
      headers: { cookie: ada.cookie },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("npm test\n");

    expect((await call("DELETE", `/api/attachments/${attached.json.id}`, ada)).status).toBe(204);
    expect((await ok("GET", `/api/documents/${plan.id}/comments`, ada))[0].attachments).toEqual([]);
  });

  test("Mentions in them are indexed: the Ticket lists the Comment under Mentioned in, naming the Document", async () => {
    const { ada, project, ticket, plan } = await documentsAndTickets();

    const comment = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "This is for cronk-1." });

    expect(comment.mentions).toEqual([{ kind: "ticket", text: "cronk-1", key: "CRONK-1", ticketId: ticket.id }]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).mentionedIn).toEqual([
      {
        kind: "comment",
        id: comment.id,
        projectId: project.id,
        title: "Plan",
        commentOn: "document",
        ticket: null,
        slug: plan.slug,
        number: null,
      },
    ]);
  });

  test("deleting the Document deletes its Comments, with their replies and files", async () => {
    const { ada, ticket, plan } = await documentsAndTickets();
    const comment = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "About CRONK-1." });
    await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Reply", replyToId: comment.id });
    const attached = await attach(`/api/comments/${comment.id}/attachments`, ada, "build.log");

    expect((await call("DELETE", `/api/documents/${plan.id}`, ada)).status).toBe(204);

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).mentionedIn).toEqual([]);
    expect((await call("GET", `/api/attachments/${attached.json.id}`, ada)).status).toBe(404);
    expect((await call("GET", `/api/documents/${plan.id}/comments`, ada)).status).toBe(404);
  });

  test("tell the Document's readers live, as they are made and get files", async () => {
    const { workspace, ada, project, plan, guide } = await documentsAndTickets();
    const stream = await openStream(cronk, ada.cookie, workspace.id);

    const comment = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Is step two needed?" });
    expect(await stream.next()).toEqual({
      type: "comment.added",
      data: { projectId: project.id, documentId: plan.id, commentId: comment.id },
    });

    await attach(`/api/comments/${comment.id}/attachments`, ada, "build.log");
    expect(await stream.next()).toEqual({ type: "attachments.changed", data: { documentId: plan.id } });

    const onGuide = await ok("POST", `/api/documents/${guide.id}/comments`, ada, { body: "More examples." });
    expect(await stream.next()).toEqual({
      type: "comment.added",
      data: { projectId: null, documentId: guide.id, commentId: onGuide.id },
    });
    stream.close();
  });
});

describe("Resolving a thread on a Document", () => {
  /** Ada's Plan with a thread of a Comment, a reply and a reply to that, and an open Comment after it. */
  async function threads() {
    const setting = await documentsAndTickets();
    const { ada, plan } = setting;
    const thread = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Is step two needed?" });
    const reply = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Yes.", replyToId: thread.id });
    const deeper = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Why?", replyToId: reply.id });
    const open = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Typo in step one." });
    return { ...setting, thread, reply, deeper, open };
  }

  test("a User resolves a thread through its first Comment, recording when and by whom, and unresolves it", async () => {
    const { user, ada, thread } = await threads();
    cronk.clock.advance(5000);

    const resolved = await ok("POST", `/api/comments/${thread.id}/resolve`, ada);

    expect(resolved).toEqual({
      ...thread,
      resolved: { at: cronk.clock.now().toISOString(), by: { kind: "user", id: user.id, name: "ada@example.com" } },
    });
    // Resolving it again changes nothing.
    cronk.clock.advance(1000);
    expect(await ok("POST", `/api/comments/${thread.id}/resolve`, ada)).toEqual(resolved);

    const unresolved = await ok("POST", `/api/comments/${thread.id}/unresolve`, ada);
    expect(unresolved).toEqual(thread);
    expect(await ok("POST", `/api/comments/${thread.id}/unresolve`, ada)).toEqual(thread);
  });

  test("a resolved thread is left out of the Document's read with all its replies, and returned on request", async () => {
    const { ada, plan, thread, reply, deeper, open } = await threads();
    const resolved = await ok("POST", `/api/comments/${thread.id}/resolve`, ada);

    expect(await ok("GET", `/api/documents/${plan.id}/comments`, ada)).toEqual([open]);
    expect((await ok("GET", `/api/documents/${plan.id}`, ada)).comments).toEqual([open]);
    const all = [resolved, reply, deeper, open];
    expect(await ok("GET", `/api/documents/${plan.id}/comments?resolved=true`, ada)).toEqual(all);
    expect((await ok("GET", `/api/documents/${plan.id}?resolved=true`, ada)).comments).toEqual(all);

    // A reply to a resolved thread leaves it resolved, and hidden with it.
    const late = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Late.", replyToId: thread.id });
    expect(await ok("GET", `/api/documents/${plan.id}/comments`, ada)).toEqual([open]);
    expect((await ok("GET", `/api/documents/${plan.id}/comments?resolved=true`, ada)).map((c: { id: string }) => c.id)).toEqual(
      [thread.id, reply.id, deeper.id, open.id, late.id],
    );

    await ok("POST", `/api/comments/${thread.id}/unresolve`, ada);
    expect((await ok("GET", `/api/documents/${plan.id}/comments`, ada)).map((c: { id: string }) => c.id)).toEqual([
      thread.id,
      reply.id,
      deeper.id,
      open.id,
      late.id,
    ]);
  });

  test("an Agent is refused, with a rule and advice, and so is a read-only token", async () => {
    const { ada, plan, thread, asAgent, asReadOnly } = await threads();

    for (const action of ["resolve", "unresolve"]) {
      const refused = await call("POST", `/api/comments/${thread.id}/${action}`, asAgent);
      expect(refused.status, action).toBe(403);
      expect(refused.json.error).toEqual({
        code: "agent_not_allowed",
        message: `claude-max is an Agent, and only a User can ${action} a thread.`,
        rule: expect.any(String),
        advice: expect.stringContaining("ada@example.com"),
      });
      expect((await call("POST", `/api/comments/${thread.id}/${action}`, asReadOnly)).json.error.code).toBe("read_only_token");
    }
    await ok("POST", `/api/comments/${thread.id}/resolve`, ada);
    expect((await call("POST", `/api/comments/${thread.id}/unresolve`, asAgent)).status).toBe(403);
    // Agents still read resolved threads on request.
    expect(await ok("GET", `/api/documents/${plan.id}/comments`, asAgent)).toHaveLength(1);
    expect(await ok("GET", `/api/documents/${plan.id}/comments?resolved=true`, asAgent)).toHaveLength(4);
  });

  test("a reply, a Ticket's or an Artifact's Comment and an unknown Comment are refused", async () => {
    const { workspace, ada, ticket, reply } = await threads();
    const onTicket = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "On the Ticket." });
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Prototype",
      files: [{ path: "index.html", contentBase64: Buffer.from("<p>Hi</p>").toString("base64") }],
    });
    const onArtifact = await ok("POST", `/api/artifacts/${artifact.id}/comments`, ada, { body: "On the Artifact." });

    const ofReply = await call("POST", `/api/comments/${reply.id}/resolve`, ada);
    expect(ofReply.status).toBe(400);
    expect(ofReply.json.error).toEqual(expect.objectContaining({ code: "not_a_thread", rule: expect.any(String) }));
    for (const comment of [onTicket, onArtifact]) {
      const refused = await call("POST", `/api/comments/${comment.id}/resolve`, ada);
      expect(refused.status).toBe(400);
      expect(refused.json.error).toEqual(expect.objectContaining({ code: "not_a_document_thread", advice: expect.any(String) }));
    }
    expect((await ok("GET", `/api/tickets/${ticket.id}/comments`, ada))[0].resolved).toBeNull();
    for (const id of ["nope", "00000000-0000-4000-8000-000000000000"]) {
      expect((await call("POST", `/api/comments/${id}/resolve`, ada)).status).toBe(404);
    }
  });

  test("tells the Document's readers live, once for each change", async () => {
    const { workspace, ada, project, plan, thread } = await threads();
    const stream = await openStream(cronk, ada.cookie, workspace.id);
    const changed = { type: "comment.changed", data: { projectId: project.id, documentId: plan.id, commentId: thread.id } };

    await ok("POST", `/api/comments/${thread.id}/resolve`, ada);
    expect(await stream.next()).toEqual(changed);
    // Resolving it again tells nobody: the next event is the unresolve.
    await ok("POST", `/api/comments/${thread.id}/resolve`, ada);
    await ok("POST", `/api/comments/${thread.id}/unresolve`, ada);
    expect(await stream.next()).toEqual(changed);
    stream.close();
  });
});

describe("Comments on a passage of a Document", () => {
  async function comment(documentId: string, as: As, body: Record<string, unknown>) {
    return call("POST", `/api/documents/${documentId}/comments`, as, body);
  }

  async function save(documentId: string, as: As, body: string) {
    const { version } = await ok("GET", `/api/documents/${documentId}`, as);
    return ok("PATCH", `/api/documents/${documentId}`, as, { baseVersion: version.number, body });
  }

  test("a User and an Agent quote a passage, recorded with its Version and placed at its offset", async () => {
    const { ada, plan, asAgent } = await documentsAndTickets();
    await save(plan.id, ada, "Step one.\n\nStep two: drag and drop.");

    const byAda = await comment(plan.id, ada, { body: "Needed?", quote: "drag and drop" });
    const byAgent = await comment(plan.id, asAgent, { body: "First?", quote: "Step one." });
    const whole = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Looks good." });
    const reply = await ok("POST", `/api/documents/${plan.id}/comments`, asAgent, { body: "Yes.", replyToId: byAda.json.id });

    expect(byAda).toEqual({
      status: 201,
      json: expect.objectContaining({ quote: "drag and drop", quoteVersion: 2, anchor: { offset: 21 } }),
    });
    expect(byAgent.json).toEqual(expect.objectContaining({ quote: "Step one.", quoteVersion: 2, anchor: { offset: 0 } }));
    // Without a quote, a Comment is on the whole Document; a reply is on its thread's passage.
    expect(whole).toEqual(expect.objectContaining({ quote: null, quoteVersion: null, anchor: null }));
    expect(reply).toEqual(expect.objectContaining({ quote: null, anchor: null }));
    expect(await ok("GET", `/api/documents/${plan.id}/comments`, ada)).toEqual([byAda.json, byAgent.json, whole, reply]);
    expect((await ok("GET", `/api/documents/${plan.id}`, ada)).comments).toEqual([byAda.json, byAgent.json, whole, reply]);
  });

  test("a quote that isn't in the current Version is refused, for Users and Agents alike", async () => {
    const { ada, plan, asAgent } = await documentsAndTickets();
    await save(plan.id, ada, "Two.");

    for (const as of [ada, asAgent]) {
      // "One." was in Version 1, not in the current one.
      const refused = await comment(plan.id, as, { body: "Here?", quote: "One." });
      expect(refused.status).toBe(400);
      expect(refused.json.error).toEqual(
        expect.objectContaining({ code: "quote_not_found", rule: expect.any(String), advice: expect.any(String) }),
      );
    }
    const empty = await comment(plan.id, ada, { body: "Here?", quote: "" });
    expect(empty.status).toBe(400);
    expect(await ok("GET", `/api/documents/${plan.id}/comments`, ada)).toEqual([]);
  });

  test("a reply takes no quote", async () => {
    const { ada, plan } = await documentsAndTickets();
    const thread = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "About this.", quote: "One." });

    const refused = await comment(plan.id, ada, { body: "And this.", quote: "One.", replyToId: thread.id });

    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe("quote_on_reply");
  });

  test("line endings are normalised when matching and placing a quote", async () => {
    const { ada, plan } = await documentsAndTickets();
    await save(plan.id, ada, "Intro.\r\nStep one.\r\nStep two.");

    const quoted = await ok("POST", `/api/documents/${plan.id}/comments`, ada, {
      body: "Split these?",
      quote: "Step one.\nStep two.",
    });
    const crlf = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Why?", quote: "Intro.\r\nStep" });

    expect(quoted).toEqual(expect.objectContaining({ quote: "Step one.\nStep two.", anchor: { offset: 7 } }));
    expect(crlf).toEqual(expect.objectContaining({ quote: "Intro.\nStep", anchor: { offset: 0 } }));
  });

  test("the offset follows edits elsewhere, and the thread is outdated once its quote is gone", async () => {
    const { ada, plan } = await documentsAndTickets();
    await save(plan.id, ada, "Step one.\n\nStep two.");
    const thread = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Needed?", quote: "Step two." });
    expect(thread.anchor).toEqual({ offset: 11 });

    await save(plan.id, ada, "# Plan\n\nStep one.\n\nStep two.");
    expect((await ok("GET", `/api/documents/${plan.id}/comments`, ada))[0].anchor).toEqual({ offset: 19 });

    await save(plan.id, ada, "# Plan\n\nStep one.\n\nStep 2.");
    const [outdated] = await ok("GET", `/api/documents/${plan.id}/comments`, ada);
    expect(outdated).toEqual(expect.objectContaining({ quote: "Step two.", quoteVersion: 2, anchor: "outdated" }));
    // An earlier Version still reads as it was, without threads.
    expect(await ok("GET", `/api/documents/${plan.id}/versions/2`, ada)).not.toHaveProperty("comments");
  });

  test("of several appearances, the first is chosen", async () => {
    const { ada, plan } = await documentsAndTickets();
    await save(plan.id, ada, "Drag. Then drag again. Drag.");

    const quoted = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Which?", quote: "drag" });
    expect(quoted.anchor).toEqual({ offset: 11 });

    await save(plan.id, ada, "Drag. Then drop.");
    expect((await ok("GET", `/api/documents/${plan.id}/comments`, ada))[0].anchor).toBe("outdated");
    await save(plan.id, ada, "drag, drag, drag");
    expect((await ok("GET", `/api/documents/${plan.id}/comments`, ada))[0].anchor).toEqual({ offset: 0 });
  });

  test("a Ticket's and an Artifact's Comments quote nothing", async () => {
    const { ada, ticket } = await documentsAndTickets();

    const onTicket = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Hi.", quote: "Hi" });

    expect(onTicket).toEqual(expect.objectContaining({ quote: null, quoteVersion: null, anchor: null }));
  });
});

describe("Access to a Document's Comments", () => {
  /** Ada's private Project CRONK listing Grace with Read and not Linus, holding a Document with a Comment. */
  async function privateProject() {
    const setting = await documentsAndTickets();
    const { workspace, ada, project, plan } = setting;
    const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
    const linus = await addMember(cronk, ada.cookie, workspace.id, "linus@example.com");
    const comment = await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Is step two needed?" });
    await ok("PUT", `/api/projects/${project.id}/access`, ada, {
      visibility: "private",
      users: [{ userId: grace.user.id, level: "read" }],
    });
    return { ...setting, grace: { cookie: grace.cookie }, linus: { cookie: linus.cookie }, comment };
  }

  test("a User with Read reads them but can't comment or reply", async () => {
    const { grace, plan, comment } = await privateProject();

    expect(await ok("GET", `/api/documents/${plan.id}/comments`, grace)).toEqual([comment]);
    expect((await ok("GET", `/api/documents/${plan.id}`, grace)).comments).toEqual([comment]);
    for (const body of [{ body: "Mine." }, { body: "A reply.", replyToId: comment.id }]) {
      const refused = await call("POST", `/api/documents/${plan.id}/comments`, grace, body);
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe("read_access");
    }
    // Nor resolve them.
    const resolving = await call("POST", `/api/comments/${comment.id}/resolve`, grace);
    expect(resolving.status).toBe(403);
    expect(resolving.json.error.code).toBe("read_access");
  });

  test("a User who can't read the Project finds neither the Document's Comments nor their files, nor hears of them", async () => {
    const { workspace, ada, linus, plan, comment } = await privateProject();
    const attached = await attach(`/api/comments/${comment.id}/attachments`, ada, "build.log");

    expect((await call("GET", `/api/documents/${plan.id}/comments`, linus)).status).toBe(404);
    expect((await call("POST", `/api/documents/${plan.id}/comments`, linus, { body: "Hi" })).status).toBe(404);
    expect((await call("GET", `/api/comments/${comment.id}/attachments`, linus)).status).toBe(404);
    expect((await call("POST", `/api/comments/${comment.id}/resolve`, linus)).status).toBe(404);
    expect((await call("GET", `/api/attachments/${attached.json.id}`, linus)).status).toBe(404);

    const stream = await openStream(cronk, linus.cookie, workspace.id);
    await ok("POST", `/api/documents/${plan.id}/comments`, ada, { body: "Secret." });
    const onGuide = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Open", body: "" });
    // The next event Linus gets is about what he can read, not the private Document's Comment.
    expect((await stream.next()).data).toEqual(expect.objectContaining({ documentId: onGuide.id }));
    stream.close();
  });

  test("a Workspace Document's Comments are for every User of the Workspace", async () => {
    const { linus, guide } = await privateProject();

    const comment = await ok("POST", `/api/documents/${guide.id}/comments`, linus, { body: "From outside." });

    expect(await ok("GET", `/api/documents/${guide.id}/comments`, linus)).toEqual([comment]);
  });
});
