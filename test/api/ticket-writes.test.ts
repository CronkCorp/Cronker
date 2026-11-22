import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { hours } from "../harness/clock.js";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream, type OpenStream } from "../harness/stream.js";

let cronk: StartedCronk;
const streams: OpenStream[] = [];
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  for (const stream of streams.splice(0)) stream.close();
  await cronk?.stop();
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  const json = response.status === 204 ? null : await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
}

/** Ada with a Project on the default board, a Ticket in Backlog, and her Agent using her fake Runner. */
async function adaWithAgent() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Pick a colour" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  const stream = async () => {
    const opened = await openStream(cronk, ada.cookie, workspace.id);
    streams.push(opened);
    return opened;
  };
  return { workspace, ada, project, ticket, agent, asAgent, status, stream };
}

const changed = (projectId: string, ticketId: string) => ({ type: "ticket.changed", data: { projectId, ticketId } });

describe("a Ticket edit, through the Ticket write module", () => {
  test("a Status change moves the time it entered its Status and takes a needs you Ticket out of the Inbox", async () => {
    const { workspace, ada, ticket, agent, asAgent, status } = await adaWithAgent();
    const inbox = () => ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "needs you", question: "Blue or green?" });
    const [question] = (await inbox()).items;
    await ok("POST", `/api/questions/${question.question.id}/dismiss`, ada);
    expect((await inbox()).items).toEqual([
      expect.objectContaining({ kind: "needsYou", since: "2026-01-01T09:00:00.000Z" }),
    ]);

    cronk.clock.advance(hours(3));
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { statusId: status("In Review") });

    expect(await inbox()).toEqual({
      count: 1,
      items: [
        expect.objectContaining({
          kind: "review",
          status: { id: status("In Review"), name: "In Review" },
          since: "2026-01-01T12:00:00.000Z",
        }),
      ],
    });
  });

  test("an edit that changes nothing leaves no Change and sends no event", async () => {
    const { ada, ticket, project, stream } = await adaWithAgent();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { priority: "high", labels: ["ui"], estimate: 3 });
    const before = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
    const events = await stream();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, {
      title: "Pick a colour",
      priority: "high",
      labels: ["ui"],
      estimate: 3,
      assigneeId: null,
      parentId: null,
    });

    await events.expectQuiet();
    expect(await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).toEqual(before);
    // A real change after it is told, so the stream was listening.
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { priority: "low" });
    expect(await events.next()).toEqual(changed(project.id, ticket.id));
  });
});

describe("passing Autonomous Delegation down", () => {
  test("records one Change and sends one event per Sub-Ticket, however deep", async () => {
    const { ada, project, ticket, stream } = await adaWithAgent();
    const newSubTicket = (parentId: string, title: string) =>
      ok("POST", `/api/projects/${project.id}/tickets`, ada, { title, parentId });
    const child = await newSubTicket(ticket.id, "Child");
    const grandchild = await newSubTicket(child.id, "Grandchild");
    const sibling = await newSubTicket(ticket.id, "Sibling");
    const events = await stream();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { autonomousDelegation: true });

    const received = [await events.next(), await events.next(), await events.next(), await events.next()];
    await events.expectQuiet();
    expect(received).toHaveLength(4);
    expect(new Set(received.map((event) => JSON.stringify(event)))).toEqual(
      new Set([ticket, child, grandchild, sibling].map((t) => JSON.stringify(changed(project.id, t.id)))),
    );
    for (const subTicket of [child, grandchild, sibling]) {
      const timeline = await ok("GET", `/api/tickets/${subTicket.id}/timeline`, ada);
      expect(timeline.filter((c: { field: string }) => c.field === "autonomousDelegation")).toEqual([
        expect.objectContaining({ field: "autonomousDelegation", from: null, to: true }),
      ]);
    }
  });
});
