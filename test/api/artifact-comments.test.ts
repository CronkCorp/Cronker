import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

/**
 * Comments on Artifacts (CRONK-15): Users and Agents comment on an Artifact as on a Ticket, with replies and
 * Attachments; a Comment on an Artifact linked to a Ticket shows with the Ticket's Comments, marked with the Artifact.
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

const files = [{ path: "index.html", contentBase64: Buffer.from("<!doctype html><p>Hi</p>").toString("base64") }];

/**
 * Ada's Workspace with a Project CRONK holding Tickets CRONK-1 and CRONK-2 and an Artifact, an Artifact of the
 * Workspace's own, and full and read-only tokens of her Agent `claude-max`.
 */
async function artifactsAndTickets() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Try drag and drop" });
  const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Something else" });
  const board = await ok("POST", `/api/projects/${project.id}/artifacts`, ada, { title: "Board prototype", files });
  const tokens = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, { title: "Colour tokens", files });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const readOnly = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "viewer", access: "read" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  const asReadOnly = { headers: { authorization: `Bearer ${readOnly.secret}` } };
  return { workspace, user, ada, project, ticket, other, board, tokens, agent, asAgent, asReadOnly };
}

describe("Comments on an Artifact", () => {
  test("a User and an Agent comment and reply on an Artifact, listed oldest first", async () => {
    const { user, ada, board, agent, asAgent } = await artifactsAndTickets();

    const posted = await call("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "The columns are too narrow." });
    cronk.clock.advance(1000);
    const reply = await ok("POST", `/api/artifacts/${board.id}/comments`, asAgent, {
      body: "Widened them in Version 2.",
      replyToId: posted.json.id,
    });

    expect(posted).toEqual({
      status: 201,
      json: {
        id: expect.any(String),
        ticketId: null,
        artifactId: board.id,
        artifact: { id: board.id, projectId: board.projectId, title: "Board prototype", slug: board.slug },
        documentId: null,
        document: null,
        replyToId: null,
        body: "The columns are too narrow.",
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
    const { avoidedWords: _, ...replied } = reply;
    expect(await ok("GET", `/api/artifacts/${board.id}/comments`, ada)).toEqual([posted.json, replied]);
    // A slug names the Artifact as its id does.
    expect(await ok("GET", `/api/artifacts/${board.slug}/comments`, ada)).toEqual([posted.json, replied]);
  });

  test("a Workspace's own Artifact takes Comments too", async () => {
    const { ada, tokens } = await artifactsAndTickets();

    const comment = await ok("POST", `/api/artifacts/${tokens.id}/comments`, ada, { body: "More contrast, please." });

    expect(comment.artifact).toEqual({ id: tokens.id, projectId: null, title: "Colour tokens", slug: tokens.slug });
    expect(await ok("GET", `/api/artifacts/${tokens.id}/comments`, ada)).toEqual([comment]);
  });

  test("a reply only goes to a Comment on the same Artifact", async () => {
    const { ada, ticket, board, tokens } = await artifactsAndTickets();
    const onTokens = await ok("POST", `/api/artifacts/${tokens.id}/comments`, ada, { body: "On the tokens." });
    const onTicket = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "On the Ticket." });
    const onBoard = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "On the board." });
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });

    for (const replyToId of [onTokens.id, onTicket.id, "nope"]) {
      const refused = await call("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "Reply", replyToId });
      expect(refused.status, replyToId).toBe(400);
      expect(refused.json.error.code, replyToId).toBe("unknown_comment");
    }
    // A Comment on a Linked Artifact is replied to on the Artifact, not on the Ticket.
    const onTheTicket = await call("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Reply", replyToId: onBoard.id });
    expect(onTheTicket.status).toBe(400);
    expect(onTheTicket.json.error.code).toBe("unknown_comment");
    expect(await ok("GET", `/api/artifacts/${board.id}/comments`, ada)).toEqual([onBoard]);
  });

  test("an empty body and an unknown Artifact are refused", async () => {
    const { ada, board } = await artifactsAndTickets();

    expect((await call("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "  " })).status).toBe(400);
    expect((await call("POST", `/api/artifacts/nope/comments`, ada, { body: "Hi" })).status).toBe(404);
    expect((await call("GET", `/api/artifacts/nope/comments`, ada)).status).toBe(404);
  });

  test("a read-only token reads an Artifact's Comments but can't comment", async () => {
    const { ada, board, asReadOnly } = await artifactsAndTickets();
    const comment = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "Looks good." });

    expect(await ok("GET", `/api/artifacts/${board.id}/comments`, asReadOnly)).toEqual([comment]);
    const refused = await call("POST", `/api/artifacts/${board.id}/comments`, asReadOnly, { body: "Hi" });
    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("read_only_token");
  });

  test("its author attaches files to it, which come with the Comment and can be downloaded", async () => {
    const { ada, board, asAgent } = await artifactsAndTickets();
    const comment = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "See the log." });

    const attached = await attach(`/api/comments/${comment.id}/attachments`, ada, "build.log");
    const byAnother = await attach(`/api/comments/${comment.id}/attachments`, asAgent, "other.log");

    expect(attached.status).toBe(201);
    expect(attached.json.on).toEqual({ kind: "comment", id: comment.id });
    expect(byAnother.status).toBe(403);
    expect(byAnother.json.error.code).toBe("not_comment_author");
    const [listed] = await ok("GET", `/api/artifacts/${board.id}/comments`, ada);
    expect(listed.attachments).toEqual([attached.json]);
    const download = await fetch(new URL(`/api/attachments/${attached.json.id}/content`, cronk.url), {
      headers: { cookie: ada.cookie },
    });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("npm test\n");

    expect((await call("DELETE", `/api/attachments/${attached.json.id}`, ada)).status).toBe(204);
    expect((await ok("GET", `/api/artifacts/${board.id}/comments`, ada))[0].attachments).toEqual([]);
  });

  test("Mentions in them are indexed: the Ticket lists the Comment under Mentioned in, naming the Artifact", async () => {
    const { ada, project, ticket, board } = await artifactsAndTickets();

    const comment = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "This is for cronk-1." });

    expect(comment.mentions).toEqual([{ kind: "ticket", text: "cronk-1", key: "CRONK-1", ticketId: ticket.id }]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).mentionedIn).toEqual([
      {
        kind: "comment",
        id: comment.id,
        projectId: project.id,
        title: "Board prototype",
        commentOn: "artifact",
        ticket: null,
        slug: board.slug,
        number: null,
      },
    ]);
  });

  test("deleting the Artifact deletes its Comments, with their replies and files", async () => {
    const { ada, ticket, board } = await artifactsAndTickets();
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    const comment = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "About CRONK-1." });
    await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "Reply", replyToId: comment.id });
    const attached = await attach(`/api/comments/${comment.id}/attachments`, ada, "build.log");

    expect((await call("DELETE", `/api/artifacts/${board.id}`, ada)).status).toBe(204);

    expect(await ok("GET", `/api/tickets/${ticket.id}/comments`, ada)).toEqual([]);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).mentionedIn).toEqual([]);
    expect((await call("GET", `/api/attachments/${attached.json.id}`, ada)).status).toBe(404);
  });
});

describe("Comments on a Linked Artifact", () => {
  test("show with the Ticket's own Comments, oldest first, marked with the Artifact; not on an unlinked Ticket", async () => {
    const { ada, ticket, other, board, tokens } = await artifactsAndTickets();
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: tokens.id });
    const first = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Built a prototype." });
    cronk.clock.advance(1000);
    const onBoard = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "Columns too narrow." });
    cronk.clock.advance(1000);
    const onTokens = await ok("POST", `/api/artifacts/${tokens.id}/comments`, ada, { body: "More contrast." });
    cronk.clock.advance(1000);
    const reply = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "Widened.", replyToId: onBoard.id });

    expect(await ok("GET", `/api/tickets/${ticket.id}/comments`, ada)).toEqual([first, onBoard, onTokens, reply]);
    expect(first.artifact).toBeNull();
    expect(onBoard.artifact.title).toBe("Board prototype");
    expect(await ok("GET", `/api/tickets/${other.id}/comments`, ada)).toEqual([]);
  });

  test("show with the Artifact's current title, and leave once it is unlinked", async () => {
    const { ada, ticket, board } = await artifactsAndTickets();
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "Columns too narrow." });
    await ok("PATCH", `/api/artifacts/${board.id}`, ada, { baseVersion: 1, title: "Drag-and-drop board" });

    const [shown] = await ok("GET", `/api/tickets/${ticket.id}/comments`, ada);
    expect(shown.artifact.title).toBe("Drag-and-drop board");

    await ok("DELETE", `/api/tickets/${ticket.id}/artifacts/${board.id}`, ada);
    expect(await ok("GET", `/api/tickets/${ticket.id}/comments`, ada)).toEqual([]);
    // Comments made before the link show once it is made.
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    expect(await ok("GET", `/api/tickets/${ticket.id}/comments`, ada)).toEqual([expect.objectContaining({ id: shown.id })]);
  });

  test("tell the Artifact's readers and the linking Tickets' readers live, as they are made and get files", async () => {
    const { workspace, ada, project, ticket, board, tokens } = await artifactsAndTickets();
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    const stream = await openStream(cronk, ada.cookie, workspace.id);

    const comment = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "Columns too narrow." });
    expect(await stream.next()).toEqual({
      type: "artifact.comments.changed",
      data: { projectId: project.id, artifactId: board.id },
    });
    expect(await stream.next()).toEqual({
      type: "comment.added",
      data: { projectId: project.id, ticketId: ticket.id, commentId: comment.id },
    });

    await attach(`/api/comments/${comment.id}/attachments`, ada, "build.log");
    expect(await stream.next()).toEqual({
      type: "artifact.comments.changed",
      data: { projectId: project.id, artifactId: board.id },
    });
    expect(await stream.next()).toEqual({ type: "attachments.changed", data: { projectId: project.id, ticketId: ticket.id } });

    // An unlinked Artifact tells only its own readers.
    await ok("POST", `/api/artifacts/${tokens.id}/comments`, ada, { body: "More contrast." });
    expect(await stream.next()).toEqual({ type: "artifact.comments.changed", data: { projectId: null, artifactId: tokens.id } });
    stream.close();
  });
});

describe("Access to an Artifact's Comments", () => {
  /** Ada's private Project CRONK listing Grace with Read and not Linus, holding an Artifact linked to CRONK-1. */
  async function privateProject() {
    const setting = await artifactsAndTickets();
    const { workspace, ada, project, ticket, board } = setting;
    const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
    const linus = await addMember(cronk, ada.cookie, workspace.id, "linus@example.com");
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    const comment = await ok("POST", `/api/artifacts/${board.id}/comments`, ada, { body: "Columns too narrow." });
    await ok("PUT", `/api/projects/${project.id}/access`, ada, {
      visibility: "private",
      users: [{ userId: grace.user.id, level: "read" }],
    });
    return { ...setting, grace: { cookie: grace.cookie }, linus: { cookie: linus.cookie }, comment };
  }

  test("a User with Read reads them, on the Artifact and its Ticket, but can't comment or reply", async () => {
    const { grace, ticket, board, comment } = await privateProject();

    expect(await ok("GET", `/api/artifacts/${board.id}/comments`, grace)).toEqual([comment]);
    expect(await ok("GET", `/api/tickets/${ticket.id}/comments`, grace)).toEqual([comment]);
    for (const body of [{ body: "Mine." }, { body: "A reply.", replyToId: comment.id }]) {
      const refused = await call("POST", `/api/artifacts/${board.id}/comments`, grace, body);
      expect(refused.status).toBe(403);
      expect(refused.json.error.code).toBe("read_access");
    }
  });

  test("a User who can't read the Project finds neither the Artifact's Comments nor their files", async () => {
    const { ada, linus, board, comment } = await privateProject();
    const attached = await attach(`/api/comments/${comment.id}/attachments`, ada, "build.log");

    expect((await call("GET", `/api/artifacts/${board.id}/comments`, linus)).status).toBe(404);
    expect((await call("POST", `/api/artifacts/${board.id}/comments`, linus, { body: "Hi" })).status).toBe(404);
    expect((await call("GET", `/api/comments/${comment.id}/attachments`, linus)).status).toBe(404);
    expect((await call("GET", `/api/attachments/${attached.json.id}`, linus)).status).toBe(404);
  });

  test("a Workspace Artifact's Comments show on a private Project's Ticket only to its readers", async () => {
    const { ada, linus, grace, ticket, tokens } = await privateProject();
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: tokens.id });
    const comment = await ok("POST", `/api/artifacts/${tokens.id}/comments`, linus, { body: "From outside." });

    // Linus reads the Workspace's own Artifact, but not the Ticket linking it.
    expect(await ok("GET", `/api/artifacts/${tokens.id}/comments`, linus)).toEqual([comment]);
    expect((await call("GET", `/api/tickets/${ticket.id}/comments`, linus)).status).toBe(404);
    expect((await ok("GET", `/api/tickets/${ticket.id}/comments`, grace)).map((c: { id: string }) => c.id)).toContain(comment.id);
  });
});
