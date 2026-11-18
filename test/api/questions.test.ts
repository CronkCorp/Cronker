import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/**
 * Ada with a Project on the default board, and a Ticket assigned to her and delegated to her Agent
 * `claude-max`, which uses her fake Runner, with a running Run of the Investigate Step.
 */
async function investigating() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Pick a colour" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, ticket, agent, asAgent, status, run };
}

describe("asking a Question", () => {
  test("finishing with needs you without a Question is refused, leaving the Run running", async () => {
    const { ada, ticket, run, asAgent, status } = await investigating();

    const response = await call("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "needs you" });

    expect(response.status).toBe(400);
    expect(response.json.error).toEqual({
      code: "question_needed",
      message: "needs you hands CRONK-1 back to its Assignee, so it takes a Question.",
      rule: "A Run that finishes with its Step's needs you Outcome says what it needs in a Question.",
      advice: "Finish with needs you again, giving a Question that says what you need from the Assignee.",
    });
    expect((await ok("GET", `/api/runs/${run.id}`, ada)).state).toBe("running");
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Investigate"));
  });
});

/** Finishes the Ticket's running Run with needs you and the Question, and returns the Question's Inbox item. */
async function ask(setup: Awaited<ReturnType<typeof investigating>>, question: string) {
  const { workspace, ada, ticket, asAgent } = setup;
  const running = (await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).find((r: { state: string }) => r.state === "running");
  await ok("POST", `/api/runs/${running.id}/finish`, asAgent, { outcome: "needs you", question });
  const { items } = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
  return items.find((item: { kind: string }) => item.kind === "question");
}

describe("where a Question shows", () => {
  test("on the Ticket as a Comment from the Agent, and in the Assignee's Inbox", async () => {
    const setup = await investigating();
    const { workspace, ada, ticket, agent, run, asAgent, status } = setup;

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, {
      outcome: "needs you",
      question: "Should the button be blue or green?",
    });

    const comments = await ok("GET", `/api/tickets/${ticket.id}/comments`, ada);
    expect(comments).toEqual([
      expect.objectContaining({
        replyToId: null,
        body: "Should the button be blue or green?",
        actor: { kind: "agent", id: agent.id, name: "claude-max" },
        questionId: expect.any(String),
      }),
    ]);
    const inbox = await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    expect(inbox.items).toContainEqual({
      kind: "question",
      ticket: expect.objectContaining({ id: ticket.id, key: "CRONK-1", statusId: status("Backlog") }),
      question: {
        id: comments[0].questionId,
        commentId: comments[0].id,
        body: "Should the button be blue or green?",
        agent: { id: agent.id, name: "claude-max" },
        step: { statusId: status("Investigate"), name: "Investigate" },
        askedAt: "2026-01-01T09:00:00.000Z",
      },
    });
  });
});

describe("answering a Question", () => {
  test("the first User's reply moves the Ticket back to the asking Step's Status and starts a new Run", async () => {
    const setup = await investigating();
    const { workspace, ada, ticket, status } = setup;
    const item = await ask(setup, "Blue or green?");

    const answer = await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Green.", replyToId: item.question.commentId });

    expect(answer).toEqual(expect.objectContaining({ body: "Green.", replyToId: item.question.commentId, questionId: null }));
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Investigate"));
    const runs = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    expect(runs.map((r: { step: { name: string }; state: string; outcome: string | null }) => [r.step.name, r.state, r.outcome])).toEqual([
      ["Investigate", "finished", "needs you"],
      ["Investigate", "running", null],
    ]);
    expect(cronk.runner.starts).toHaveLength(2);
    // The User who answered moved it back.
    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(timeline.at(-1)).toEqual(
      expect.objectContaining({
        actor: expect.objectContaining({ kind: "user", name: "ada@example.com" }),
        field: "status",
        from: { id: status("Backlog"), name: "Backlog" },
        to: { id: status("Investigate"), name: "Investigate" },
      }),
    );
    // Answered, the Question leaves the Inbox.
    expect((await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada)).items).toEqual([]);
  });

  test("only the first User's reply answers: a second one, or an Agent's, is just a Comment", async () => {
    const setup = await investigating();
    const { workspace, ada, ticket, asAgent, status } = setup;
    const item = await ask(setup, "Blue or green?");

    await ok("POST", `/api/tickets/${ticket.id}/comments`, asAgent, { body: "Still wondering.", replyToId: item.question.commentId });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Backlog"));
    expect((await ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada)).items).toContainEqual(
      expect.objectContaining({ kind: "question" }),
    );

    await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "Green.", replyToId: item.question.commentId });
    // The new Run asks again before Ada replies a second time to the first Question.
    await ask(setup, "Which green?");
    await ok("POST", `/api/tickets/${ticket.id}/comments`, ada, { body: "And bold.", replyToId: item.question.commentId });

    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).statusId).toBe(status("Backlog"));
    expect(cronk.runner.starts).toHaveLength(2);
  });
});
