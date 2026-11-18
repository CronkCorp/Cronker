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
 * Ada with a Project on the default board, a Ticket CRONK-1 her Agent `claude-max` is running a Triage Run on,
 * through her fake Runner, and a second Ticket CRONK-2 in Backlog.
 */
async function runningRun() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Something else" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, ticket, other, agent, run, asAgent, status };
}

describe("Sub-Tickets an Agent creates in its Run", () => {
  test("start in Backlog under its Ticket, with the parent's Assignee and Delegation, the Change naming the Run", async () => {
    const { user, ada, project, ticket, agent, run, asAgent, status } = await runningRun();

    const sub = await ok("POST", `/api/projects/${project.id}/tickets`, asAgent, {
      title: "Parse the header",
      description: "The first half.",
      parentId: ticket.id,
    });

    expect(sub).toEqual(
      expect.objectContaining({
        key: "CRONK-3",
        title: "Parse the header",
        description: "The first half.",
        statusId: status("Backlog"),
        parentId: ticket.id,
        assigneeId: user.id,
        delegateId: agent.id,
        discovered: null,
      }),
    );
    const timeline = await ok("GET", `/api/tickets/${sub.id}/timeline`, ada);
    expect(timeline.map((c: { field: string; actor: { kind: string; id: string }; runId: string }) => [c.field, c.actor.id, c.runId])).toEqual([
      ["created", agent.id, run.id],
    ]);
    const relations = await ok("GET", `/api/tickets/${ticket.id}/relations`, ada);
    expect(relations.subTickets.map((t: { key: string }) => t.key)).toEqual(["CRONK-3"]);
    const parentTimeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    expect(parentTimeline.at(-1)).toEqual(
      expect.objectContaining({ field: "subTicket", from: null, to: expect.objectContaining({ key: "CRONK-3" }), runId: run.id }),
    );
  });

  test("the parent gets no Run until its Sub-Tickets are finished", async () => {
    const { ada, project, ticket, run, asAgent, status } = await runningRun();
    const sub = await ok("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "First half", parentId: ticket.id });
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("Investigate") });
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).waiting).toBe("blocked");
    expect(await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).toHaveLength(1);

    await ok("PATCH", `/api/tickets/${sub.id}`, ada, { statusId: status("Done") });
    await expect.poll(async () => (await ok("GET", `/api/tickets/${ticket.id}/runs`, ada)).length).toBe(2);
  });

  test("an Agent splits only its own running Run's Ticket", async () => {
    const { ada, project, ticket, other, run, asAgent } = await runningRun();

    const refused = await call("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "Nope", parentId: other.id });
    expect(refused.status).toBe(403);
    expect(refused.json.error).toEqual(expect.objectContaining({ code: "no_running_run", advice: expect.any(String) }));

    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    const afterRun = await call("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "Late", parentId: ticket.id });
    expect(afterRun.json.error.code).toBe("no_running_run");
    expect(await ok("GET", `/api/projects/${project.id}/tickets`, ada)).toHaveLength(2);
  });

  test("a User's Sub-Ticket also starts with its parent's Assignee and Delegation", async () => {
    const { user, ada, project, ticket, agent } = await runningRun();

    const sub = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Mine", parentId: ticket.id });

    expect(sub).toEqual(expect.objectContaining({ parentId: ticket.id, assigneeId: user.id, delegateId: agent.id }));
  });
});

describe("Discovered Tickets", () => {
  test("start in Backlog, undelegated, assigned to the source Ticket's Assignee, recording the source and the Run", async () => {
    const { user, ada, project, ticket, agent, run, asAgent, status } = await runningRun();
    await ok("PATCH", `/api/projects/${project.id}`, ada, { newTicketsDelegated: true });

    const found = await ok("POST", `/api/projects/${project.id}/tickets`, asAgent, {
      title: "The parser drops comments",
      description: "Seen while triaging CRONK-1.",
      runId: run.id,
    });

    expect(found).toEqual(
      expect.objectContaining({
        key: "CRONK-3",
        statusId: status("Backlog"),
        parentId: null,
        assigneeId: user.id,
        delegateId: null,
        discovered: {
          agentId: agent.id,
          sourceTicket: { id: ticket.id, projectId: project.id, key: "CRONK-1", title: "Make it so" },
          runId: run.id,
          waiting: true,
        },
      }),
    );
    const [created] = await ok("GET", `/api/tickets/${found.id}/timeline`, ada);
    expect(created).toEqual(expect.objectContaining({ field: "created", runId: run.id, actor: expect.objectContaining({ id: agent.id }) }));
  });

  test("filed outside a Run, one is assigned to the Agent's Owner with no source", async () => {
    const { user, project, agent, run, asAgent } = await runningRun();
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    const found = await ok("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "Noticed by hand" });

    expect(found).toEqual(
      expect.objectContaining({
        assigneeId: user.id,
        delegateId: null,
        discovered: { agentId: agent.id, sourceTicket: null, runId: null, waiting: true },
      }),
    );
  });

  test("naming a Run that isn't the Agent's running one is refused", async () => {
    const { ada, project, run, asAgent } = await runningRun();
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });

    const refused = await call("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "Late", runId: run.id });

    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("no_running_run");
    const byUser = await call("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Mine", runId: run.id });
    expect(byUser.json.error.code).toBe("run_for_agents");
    expect(await ok("GET", `/api/projects/${project.id}/tickets`, ada)).toHaveLength(2);
  });

  test("a read-only token files nothing", async () => {
    const { ada, project, agent } = await runningRun();
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "peek", access: "read" });

    const refused = await call("POST", `/api/projects/${project.id}/tickets`, { headers: { authorization: `Bearer ${secret}` } }, { title: "No" });

    expect(refused.json.error.code).toBe("read_only_token");
  });
});

describe("the filing Agent and its Discovered Ticket", () => {
  /** A running Run whose Agent filed CRONK-3 from it, then finished the Run. */
  async function discovered() {
    const setup = await runningRun();
    const { project, run, asAgent } = setup;
    const found = await ok("POST", `/api/projects/${project.id}/tickets`, setup.asAgent, { title: "Found it", runId: run.id });
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
    return { ...setup, found };
  }

  test("edits it after its Run, title included, each Change naming the Agent", async () => {
    const { ada, agent, found, asAgent } = await discovered();

    const edited = await ok("PATCH", `/api/tickets/${found.id}`, asAgent, {
      title: "Found it: the parser drops comments",
      description: "Reproduce with `-- x`.",
      priority: "high",
      labels: ["bug"],
    });

    expect(edited).toEqual(
      expect.objectContaining({ title: "Found it: the parser drops comments", priority: "high", labels: ["bug"] }),
    );
    const timeline = await ok("GET", `/api/tickets/${found.id}/timeline`, ada);
    expect(timeline.slice(1).map((c: { field: string; actor: { id: string }; runId: string | null }) => [c.field, c.actor.id, c.runId])).toEqual([
      ["title", agent.id, null],
      ["description", agent.id, null],
      ["priority", agent.id, null],
      ["labels", agent.id, null],
    ]);
  });

  test("still doesn't set its Assignee, Delegation, parent or Status", async () => {
    const { user, found, asAgent, status } = await discovered();

    for (const edit of [{ assigneeId: user.id }, { delegateId: null }, { parentId: null }]) {
      const refused = await call("PATCH", `/api/tickets/${found.id}`, asAgent, edit);
      expect(refused.json.error.code).toBe("agent_field_not_allowed");
    }
    const moved = await call("PATCH", `/api/tickets/${found.id}`, asAgent, { statusId: status("Ready") });
    expect(moved.json.error.code).toBe("agent_sets_no_status");
  });

  test("adds blocks from it to Tickets of its Workspace, each Change naming the Agent", async () => {
    const { ada, ticket, agent, found, asAgent } = await discovered();

    const relation = await ok("POST", `/api/tickets/${found.id}/relations`, asAgent, { kind: "blocks", ticketKey: "cronk-1" });

    expect(relation).toEqual(expect.objectContaining({ kind: "blocks", ticket: expect.objectContaining({ key: "CRONK-1" }) }));
    const { relations } = await ok("GET", `/api/tickets/${ticket.id}/relations`, ada);
    expect(relations.map((r: { kind: string; ticket: { key: string } }) => [r.kind, r.ticket.key])).toEqual([["blockedBy", "CRONK-3"]]);
    const [blockedBy] = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).slice(-1);
    expect(blockedBy).toEqual(expect.objectContaining({ field: "blockedBy", actor: expect.objectContaining({ id: agent.id }), runId: null }));
  });

  test("adds only blocks from it: no other Relation, and none from another Ticket", async () => {
    const { ticket, other, found, asAgent } = await discovered();

    for (const kind of ["blockedBy", "relatesTo"]) {
      const refused = await call("POST", `/api/tickets/${found.id}/relations`, asAgent, { kind, ticketId: ticket.id });
      expect(refused.status, kind).toBe(403);
      expect(refused.json.error.code, kind).toBe("agent_adds_only_blocks");
    }
    const fromOther = await call("POST", `/api/tickets/${other.id}/relations`, asAgent, { kind: "blocks", ticketId: ticket.id });
    expect(fromOther.status).toBe(403);
    expect(fromOther.json.error).toEqual(expect.objectContaining({ code: "not_your_discovered_ticket", advice: expect.any(String) }));
  });

  test("a block that would form a cycle is still refused", async () => {
    const { ada, ticket, found, asAgent } = await discovered();
    await ok("POST", `/api/tickets/${ticket.id}/relations`, ada, { kind: "blocks", ticketId: found.id });

    const refused = await call("POST", `/api/tickets/${found.id}/relations`, asAgent, { kind: "blocks", ticketId: ticket.id });

    expect(refused.json.error.code).toBe("blocking_cycle");
  });

  test("another Agent doesn't edit it", async () => {
    const { workspace, ada, found } = await discovered();
    const otherAgent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "other" });
    const { secret } = await ok("POST", `/api/agents/${otherAgent.id}/tokens`, ada, { name: "t", access: "full" });

    const refused = await call("PATCH", `/api/tickets/${found.id}`, { headers: { authorization: `Bearer ${secret}` } }, { priority: "low" });

    expect(refused.status).toBe(403);
    expect(refused.json.error.code).toBe("no_running_run");
  });
});
