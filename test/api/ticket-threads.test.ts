import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

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

/**
 * Ada with a Project CRONK and its Ticket CRONK-1, which her Agent `claude-max` is running a Triage Run on and has
 * written a Report on; and a spec Document of the Project and a Workspace style guide, both linked to the Ticket.
 */
async function ticketUnderReview() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Sign in with GitHub" });
  const spec = await ok("POST", `/api/projects/${project.id}/documents`, ada, {
    title: "Spec",
    body: "Sign in with GitHub.\n\nKeep the session for a week.",
  });
  const style = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Style guide", body: "Be brief." });
  await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: spec.id });
  await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: style.id });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
  const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, {
    title: "Findings",
    body: "Use the OAuth app.\n\nStore tokens in the session.",
  });
  return { workspace, user, ada, project, ticket, spec, style, agent, asAgent, report };
}

const ids = (comments: { id: string }[]) => comments.map((c) => c.id);

describe("Document reviews reach the Ticket", () => {
  test("the Ticket's Reports and Linked Documents carry their unresolved threads, with quotes and whether each is outdated", async () => {
    const { ada, ticket, spec, style, asAgent, report } = await ticketUnderReview();
    const onReport = await ok("POST", `/api/documents/${report.id}/comments`, ada, {
      body: "Which OAuth app?",
      quote: "Use the OAuth app.",
    });
    const reply = await ok("POST", `/api/documents/${report.id}/comments`, asAgent, { body: "Cronk's.", replyToId: onReport.id });
    const whole = await ok("POST", `/api/documents/${report.id}/comments`, ada, { body: "Looks right." });
    const settled = await ok("POST", `/api/documents/${spec.id}/comments`, ada, { body: "A day?", quote: "Sign in with GitHub." });
    await ok("POST", `/api/documents/${spec.id}/comments`, ada, { body: "Agreed.", replyToId: settled.id });
    await ok("POST", `/api/comments/${settled.id}/resolve`, ada);
    const onSpec = await ok("POST", `/api/documents/${spec.id}/comments`, ada, {
      body: "Why a week?",
      quote: "Keep the session for a week.",
    });
    // The passage it quotes goes, so the thread is outdated.
    await ok("PATCH", `/api/documents/${spec.id}`, ada, { baseVersion: 1, body: "Sign in with GitHub.\n\nKeep the session for a day." });

    const [reportRead] = await ok("GET", `/api/tickets/${ticket.id}/reports`, ada);
    expect(reportRead.threads).toEqual([
      { ...onReport, anchor: { offset: 0 } },
      expect.objectContaining({ id: reply.id, replyToId: onReport.id }),
      expect.objectContaining({ id: whole.id, quote: null, anchor: null }),
    ]);
    const linked = await ok("GET", `/api/tickets/${ticket.id}/documents`, ada);
    expect(linked.map((d: { id: string }) => d.id)).toEqual([spec.id, style.id]);
    expect(linked[0].threads).toEqual([
      expect.objectContaining({
        id: onSpec.id,
        quote: "Keep the session for a week.",
        quoteVersion: 1,
        anchor: "outdated",
        resolved: null,
      }),
    ]);
    expect(linked[1].threads).toEqual([]);
  });

  test("a Comment on a Report shows on its Ticket's timeline, marked with the Report; those on other Linked Documents don't", async () => {
    const { ada, ticket, spec, report, asAgent } = await ticketUnderReview();
    const own = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Starting." });
    const onReport = await ok("POST", `/api/documents/${report.id}/comments`, ada, { body: "Which OAuth app?" });
    await ok("POST", `/api/documents/${spec.id}/comments`, ada, { body: "On the spec." });
    // A reply from the timeline goes to the Report, as its Comment names it.
    const reply = await ok("POST", `/api/documents/${onReport.documentId}/comments`, asAgent, {
      body: "Cronk's.",
      replyToId: onReport.id,
    });

    const timeline = await ok("GET", `/api/tickets/${ticket.id}/comments`, ada);
    expect(ids(timeline)).toEqual([own.id, onReport.id, reply.id]);
    expect(timeline[1]).toEqual(
      expect.objectContaining({
        ticketId: null,
        documentId: report.id,
        document: { id: report.id, projectId: ticket.projectId, title: "Findings", slug: report.slug },
      }),
    );
  });

  test("a Comment on a Report tells its Ticket's streams, as well as the Report's", async () => {
    const { workspace, ada, project, ticket, report } = await ticketUnderReview();
    const stream = await openStream(cronk, ada.cookie!, workspace.id);

    const comment = await ok("POST", `/api/documents/${report.id}/comments`, ada, { body: "Which OAuth app?" });

    expect(await stream.next()).toEqual({
      type: "comment.added",
      data: { projectId: project.id, documentId: report.id, commentId: comment.id },
    });
    expect(await stream.next()).toEqual({
      type: "comment.added",
      data: { projectId: project.id, ticketId: ticket.id, commentId: comment.id },
    });
    stream.close();
  });

  test("threads of a Document the reader can't read never appear", async () => {
    const { workspace, ada, ticket, style, asAgent } = await ticketUnderReview();
    await ok("POST", `/api/documents/${style.id}/comments`, ada, { body: "Briefer still." });
    // Her Agent may no longer read the Workspace's own knowledge, so the style guide is out of its reach.
    await cronk.stage("update workspaces set agent_access = 'none' where id = $1", [workspace.id]);

    const linked = await ok("GET", `/api/tickets/${ticket.id}/documents`, asAgent);
    expect(linked.map((d: { title: string }) => d.title)).toEqual(["Spec"]);
    expect(JSON.stringify(linked)).not.toContain("Briefer still.");
    expect(JSON.stringify(await ok("GET", `/api/tickets/${ticket.id}/comments`, asAgent))).not.toContain("Briefer still.");
  });
});
