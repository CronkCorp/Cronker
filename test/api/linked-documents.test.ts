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
 * Ada's Workspace with a Project CRONK holding a Ticket CRONK-1 and a Document, a Document in the Workspace's own
 * page tree, and a full token of her Agent `claude-max`.
 */
async function ticketWithDocuments() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Sign in with GitHub" });
  const design = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Sign-in design" });
  const style = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Style guide" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, ticket, design, style, agent, asAgent };
}

describe("Linked Documents", () => {
  test("a User links Documents of the Ticket's Project and of the Workspace, listed oldest first", async () => {
    const { ada, project, ticket, design, style } = await ticketWithDocuments();

    const linked = await call("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: style.id });

    expect(linked).toEqual({ status: 201, json: { id: design.id, projectId: project.id, title: "Sign-in design", slug: design.slug } });
    expect(await ok("GET", `/api/tickets/${ticket.id}/documents`, ada)).toEqual([
      { id: design.id, projectId: project.id, title: "Sign-in design", slug: design.slug },
      { id: style.id, projectId: null, title: "Style guide", slug: style.slug },
    ]);
  });

  test("only a Document of the Ticket's Project or of its Workspace can be linked", async () => {
    const { workspace, ada, ticket } = await ticketWithDocuments();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Board", key: "BOARD" });
    const elsewhere = await ok("POST", `/api/projects/${other.id}/documents`, ada, { title: "Board notes" });
    const away = await ok("POST", "/api/workspaces", ada, { name: "Side project" });
    const outside = await ok("POST", `/api/workspaces/${away.id}/documents`, ada, { title: "Side notes" });

    const fromOtherProject = await call("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: elsewhere.id });
    const fromOtherWorkspace = await call("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: outside.id });
    const noSuchDocument = await call("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: "nope" });

    expect(fromOtherProject.status).toBe(400);
    expect(fromOtherProject.json.error).toEqual(
      expect.objectContaining({ code: "document_outside_project", rule: expect.any(String), advice: expect.any(String) }),
    );
    // A Document of another Workspace answers as unknown, as if it didn't exist.
    expect(fromOtherWorkspace.status).toBe(400);
    expect(fromOtherWorkspace.json.error.code).toBe("unknown_document");
    expect(noSuchDocument.status).toBe(400);
    expect(noSuchDocument.json.error.code).toBe("unknown_document");
    expect(await ok("GET", `/api/tickets/${ticket.id}/documents`, ada)).toEqual([]);
  });

  test("a Document is linked to a Ticket once", async () => {
    const { ada, ticket, design } = await ticketWithDocuments();
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });

    const again = await call("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });

    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("document_already_linked");
  });

  test("a User unlinks a Document, which stays in its page tree", async () => {
    const { ada, project, ticket, design, style } = await ticketWithDocuments();
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: style.id });

    const unlinked = await call("DELETE", `/api/tickets/${ticket.id}/documents/${design.id}`, ada);
    const again = await call("DELETE", `/api/tickets/${ticket.id}/documents/${design.id}`, ada);

    expect(unlinked.status).toBe(204);
    expect(again.status).toBe(404);
    expect(await ok("GET", `/api/tickets/${ticket.id}/documents`, ada)).toEqual([
      { id: style.id, projectId: null, title: "Style guide", slug: style.slug },
    ]);
    expect((await ok("GET", `/api/projects/${project.id}/documents`, ada)).map((d: { id: string }) => d.id)).toEqual([
      design.id,
    ]);
  });

  test("a deleted Document drops out of its links", async () => {
    const { ada, ticket, design, style } = await ticketWithDocuments();
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: style.id });

    await ok("DELETE", `/api/documents/${design.id}`, ada);

    expect(await ok("GET", `/api/tickets/${ticket.id}/documents`, ada)).toEqual([
      { id: style.id, projectId: null, title: "Style guide", slug: style.slug },
    ]);
  });

  test("a Linked Document shows its current title", async () => {
    const { ada, ticket, design } = await ticketWithDocuments();
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });

    await ok("PATCH", `/api/documents/${design.id}`, ada, { baseVersion: 1, title: "GitHub sign-in design" });

    expect(await ok("GET", `/api/tickets/${ticket.id}/documents`, ada)).toEqual([
      expect.objectContaining({ id: design.id, title: "GitHub sign-in design" }),
    ]);
  });

  test("linking and unlinking are Changes on the Ticket's timeline, naming the Document as it was titled", async () => {
    const { user, ada, ticket, design } = await ticketWithDocuments();
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });
    await ok("PATCH", `/api/documents/${design.id}`, ada, { baseVersion: 1, title: "GitHub sign-in design" });
    cronk.clock.advance(60_000);
    await ok("DELETE", `/api/tickets/${ticket.id}/documents/${design.id}`, ada);

    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);

    const byAda = { kind: "user", id: user.id, name: "ada@example.com" };
    expect(timeline.slice(1)).toEqual([
      expect.objectContaining({
        actor: byAda,
        field: "linkedDocument",
        from: null,
        to: { id: design.id, title: "Sign-in design" },
        at: "2026-01-01T09:00:00.000Z",
        runId: null,
      }),
      expect.objectContaining({
        actor: byAda,
        field: "linkedDocument",
        from: { id: design.id, title: "GitHub sign-in design" },
        to: null,
        at: "2026-01-01T09:01:00.000Z",
      }),
    ]);
  });

  test("linking, unlinking and deleting a Linked Document tell the Workspace's streams the Ticket changed", async () => {
    const { workspace, ada, project, ticket, design } = await ticketWithDocuments();
    const stream = await openStream(cronk, ada.cookie, workspace.id);
    const changed = { type: "ticket.changed", data: { projectId: project.id, ticketId: ticket.id } };

    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });
    expect(await stream.next()).toEqual(changed);
    await ok("DELETE", `/api/tickets/${ticket.id}/documents/${design.id}`, ada);
    expect(await stream.next()).toEqual(changed);
    await ok("POST", `/api/tickets/${ticket.id}/documents`, ada, { documentId: design.id });
    expect(await stream.next()).toEqual(changed);
    await ok("DELETE", `/api/documents/${design.id}`, ada);
    expect(await stream.next()).toEqual(changed);
    stream.close();
  });

  describe("by an Agent", () => {
    /** The Agent `claude-max` running a Triage Run on CRONK-1 through Ada's fake Runner, and a second Ticket CRONK-2. */
    async function runningRun() {
      const setup = await ticketWithDocuments();
      const { ada, project, ticket, agent } = setup;
      const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Something else" });
      const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
      await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: runner.id });
      const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
      await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
      const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
      return { ...setup, other, run };
    }

    test("during its Run on the Ticket, an Agent links and unlinks Documents, each Change naming its Run", async () => {
      const { ada, ticket, design, style, agent, asAgent, run } = await runningRun();

      await ok("POST", `/api/tickets/${ticket.id}/documents`, asAgent, { documentId: design.id });
      await ok("POST", `/api/tickets/${ticket.id}/documents`, asAgent, { documentId: style.id });
      await ok("DELETE", `/api/tickets/${ticket.id}/documents/${style.id}`, asAgent);

      expect(await ok("GET", `/api/tickets/${ticket.id}/documents`, asAgent)).toEqual([
        expect.objectContaining({ id: design.id }),
      ]);
      const changes = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).filter(
        (c: { field: string }) => c.field === "linkedDocument",
      );
      expect(changes).toHaveLength(3);
      for (const change of changes) {
        expect(change).toEqual(
          expect.objectContaining({ actor: { kind: "agent", id: agent.id, name: "claude-max" }, runId: run.id }),
        );
      }
    });

    test("an Agent may not link or unlink outside a running Run on the Ticket", async () => {
      const { ada, ticket, other, design, asAgent, run } = await runningRun();
      await ok("POST", `/api/tickets/${other.id}/documents`, ada, { documentId: design.id });

      const onAnotherTicket = await call("POST", `/api/tickets/${other.id}/documents`, asAgent, { documentId: design.id });
      const unlinkOnAnother = await call("DELETE", `/api/tickets/${other.id}/documents/${design.id}`, asAgent);
      await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
      const afterItsRun = await call("POST", `/api/tickets/${ticket.id}/documents`, asAgent, { documentId: design.id });

      for (const refused of [onAnotherTicket, unlinkOnAnother, afterItsRun]) {
        expect(refused.status).toBe(403);
        expect(refused.json.error).toEqual(
          expect.objectContaining({ code: "no_running_run", rule: expect.any(String), advice: expect.any(String) }),
        );
      }
      expect(await ok("GET", `/api/tickets/${other.id}/documents`, ada)).toEqual([expect.objectContaining({ id: design.id })]);
      expect(await ok("GET", `/api/tickets/${ticket.id}/documents`, ada)).toEqual([]);
    });

    /** `claude-max`, with no Run, files CRONK-2 as a Discovered Ticket that waits for Ada. */
    async function discovered() {
      const setup = await ticketWithDocuments();
      const found = await ok("POST", `/api/projects/${setup.project.id}/tickets`, setup.asAgent, { title: "Found it" });
      return { ...setup, found };
    }

    test("outside a Run, an Agent links and unlinks Documents on a waiting Discovered Ticket it filed", async () => {
      const { ada, found, design, style, agent, asAgent } = await discovered();

      await ok("POST", `/api/tickets/${found.id}/documents`, asAgent, { documentId: design.id });
      await ok("POST", `/api/tickets/${found.id}/documents`, asAgent, { documentId: style.id });
      await ok("DELETE", `/api/tickets/${found.id}/documents/${style.id}`, asAgent);

      expect(await ok("GET", `/api/tickets/${found.id}/documents`, ada)).toEqual([expect.objectContaining({ id: design.id })]);
      const changes = (await ok("GET", `/api/tickets/${found.id}/timeline`, ada)).filter(
        (c: { field: string }) => c.field === "linkedDocument",
      );
      expect(changes.map((c: { actor: { id: string }; runId: string | null }) => [c.actor.id, c.runId])).toEqual([
        [agent.id, null],
        [agent.id, null],
        [agent.id, null],
      ]);
    });

    test("outside a Run, an Agent may not link or unlink on a Ticket it didn't file, or one a User has taken up", async () => {
      const { workspace, ada, project, ticket, found, design, asAgent } = await discovered();
      const moved = await ok("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "Found that too" });
      const ready = project.statuses.find((s: { name: string }) => s.name === "Ready").id;
      await ok("PATCH", `/api/tickets/${moved.id}`, ada, { statusId: ready });
      const other = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "other" });
      const { secret } = await ok("POST", `/api/agents/${other.id}/tokens`, ada, { name: "t", access: "full" });
      const asOther = { headers: { authorization: `Bearer ${secret}` } };
      await ok("POST", `/api/tickets/${found.id}/documents`, asAgent, { documentId: design.id });

      const onAUsersTicket = await call("POST", `/api/tickets/${ticket.id}/documents`, asAgent, { documentId: design.id });
      const byAnotherAgent = await call("DELETE", `/api/tickets/${found.id}/documents/${design.id}`, asOther);
      await ok("POST", `/api/tickets/${found.id}/dismiss`, ada);
      const afterDismissed = await call("DELETE", `/api/tickets/${found.id}/documents/${design.id}`, asAgent);
      const afterMoved = await call("POST", `/api/tickets/${moved.id}/documents`, asAgent, { documentId: design.id });

      expect(onAUsersTicket.status).toBe(403);
      expect(onAUsersTicket.json.error).toEqual(
        expect.objectContaining({ code: "no_running_run", rule: expect.stringContaining("Discovered Ticket it filed") }),
      );
      for (const refused of [byAnotherAgent, afterDismissed, afterMoved]) {
        expect(refused.status).toBe(403);
        expect(refused.json.error).toEqual(
          expect.objectContaining({
            code: "not_your_discovered_ticket",
            rule: expect.stringContaining("Discovered Ticket it filed"),
            advice: expect.any(String),
          }),
        );
      }
      expect(await ok("GET", `/api/tickets/${ticket.id}/documents`, ada)).toEqual([]);
      expect(await ok("GET", `/api/tickets/${found.id}/documents`, ada)).toEqual([expect.objectContaining({ id: design.id })]);
      expect(await ok("GET", `/api/tickets/${moved.id}/documents`, ada)).toEqual([]);
    });

    test("outside a Run, an Agent links Documents on a Sub-Ticket of its waiting Discovered Ticket", async () => {
      const { ada, project, found, design, agent, asAgent } = await discovered();
      const half = await ok("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "Half", parentId: found.id });

      await ok("POST", `/api/tickets/${half.id}/documents`, asAgent, { documentId: design.id });

      expect(await ok("GET", `/api/tickets/${half.id}/documents`, ada)).toEqual([expect.objectContaining({ id: design.id })]);
      await ok("PATCH", `/api/tickets/${found.id}`, ada, { delegateId: agent.id });
      const settled = await call("DELETE", `/api/tickets/${half.id}/documents/${design.id}`, asAgent);
      expect(settled.json.error.code).toBe("not_your_discovered_ticket");
    });

    test("an Agent links only Documents of its Discovered Ticket's Project or of the Workspace", async () => {
      const { workspace, ada, found, asAgent } = await discovered();
      const board = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Board", key: "BOARD" });
      const elsewhere = await ok("POST", `/api/projects/${board.id}/documents`, ada, { title: "Board notes" });

      const refused = await call("POST", `/api/tickets/${found.id}/documents`, asAgent, { documentId: elsewhere.id });

      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe("document_outside_project");
    });
  });
});
