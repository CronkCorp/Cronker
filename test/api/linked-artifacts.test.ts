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

const files = [{ path: "index.html", contentBase64: Buffer.from("<!doctype html><p>Hi</p>").toString("base64") }];

/**
 * Ada's Workspace with a Project CRONK holding a Ticket CRONK-1 and an Artifact, an Artifact of the Workspace's own,
 * and a full token of her Agent `claude-max`.
 */
async function ticketWithArtifacts() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Try drag and drop" });
  const board = await ok("POST", `/api/projects/${project.id}/artifacts`, ada, { title: "Board prototype", files });
  const tokens = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, { title: "Colour tokens", files });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, ticket, board, tokens, agent, asAgent };
}

describe("Linked Artifacts", () => {
  test("a User links Artifacts of the Ticket's Project and of the Workspace, listed oldest first", async () => {
    const { ada, project, ticket, board, tokens } = await ticketWithArtifacts();

    const linked = await call("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: tokens.id });

    expect(linked).toEqual({ status: 201, json: { id: board.id, projectId: project.id, title: "Board prototype", slug: board.slug } });
    expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([
      { id: board.id, projectId: project.id, title: "Board prototype", slug: board.slug },
      { id: tokens.id, projectId: null, title: "Colour tokens", slug: tokens.slug },
    ]);
  });

  test("only an Artifact of the Ticket's Project or of its Workspace can be linked", async () => {
    const { workspace, ada, ticket } = await ticketWithArtifacts();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Board", key: "BOARD" });
    const elsewhere = await ok("POST", `/api/projects/${other.id}/artifacts`, ada, { title: "Board mock", files });
    const away = await ok("POST", "/api/workspaces", ada, { name: "Side project" });
    const outside = await ok("POST", `/api/workspaces/${away.id}/artifacts`, ada, { title: "Side mock", files });

    const fromOtherProject = await call("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: elsewhere.id });
    const fromOtherWorkspace = await call("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: outside.id });
    const noSuchArtifact = await call("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: "nope" });

    expect(fromOtherProject.status).toBe(400);
    expect(fromOtherProject.json.error).toEqual(
      expect.objectContaining({ code: "artifact_outside_project", rule: expect.any(String), advice: expect.any(String) }),
    );
    // An Artifact of another Workspace answers as unknown, as if it didn't exist.
    expect(fromOtherWorkspace.status).toBe(400);
    expect(fromOtherWorkspace.json.error.code).toBe("unknown_artifact");
    expect(noSuchArtifact.status).toBe(400);
    expect(noSuchArtifact.json.error.code).toBe("unknown_artifact");
    expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([]);
  });

  test("an Artifact is linked to a Ticket once", async () => {
    const { ada, ticket, board } = await ticketWithArtifacts();
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });

    const again = await call("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });

    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("artifact_already_linked");
  });

  test("a User unlinks an Artifact, which stays in its Project", async () => {
    const { ada, project, ticket, board, tokens } = await ticketWithArtifacts();
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: tokens.id });

    const unlinked = await call("DELETE", `/api/tickets/${ticket.id}/artifacts/${board.id}`, ada);
    const again = await call("DELETE", `/api/tickets/${ticket.id}/artifacts/${board.id}`, ada);

    expect(unlinked.status).toBe(204);
    expect(again.status).toBe(404);
    expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([
      { id: tokens.id, projectId: null, title: "Colour tokens", slug: tokens.slug },
    ]);
    expect((await ok("GET", `/api/projects/${project.id}/artifacts`, ada)).map((a: { id: string }) => a.id)).toEqual([board.id]);
  });

  test("linking and unlinking are Changes on the Ticket's timeline, naming the Artifact as it was titled", async () => {
    const { user, ada, ticket, board } = await ticketWithArtifacts();
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    await ok("PATCH", `/api/artifacts/${board.id}`, ada, { baseVersion: 1, title: "Drag-and-drop board" });
    cronk.clock.advance(60_000);
    await ok("DELETE", `/api/tickets/${ticket.id}/artifacts/${board.id}`, ada);

    const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);

    const byAda = { kind: "user", id: user.id, name: "ada@example.com" };
    expect(timeline.slice(1)).toEqual([
      expect.objectContaining({
        actor: byAda,
        field: "linkedArtifact",
        from: null,
        to: { id: board.id, title: "Board prototype" },
        at: "2026-01-01T09:00:00.000Z",
        runId: null,
      }),
      expect.objectContaining({
        actor: byAda,
        field: "linkedArtifact",
        from: { id: board.id, title: "Drag-and-drop board" },
        to: null,
        at: "2026-01-01T09:01:00.000Z",
      }),
    ]);
  });

  test("linking and unlinking tell the Workspace's streams the Ticket changed", async () => {
    const { workspace, ada, project, ticket, board } = await ticketWithArtifacts();
    const stream = await openStream(cronk, ada.cookie, workspace.id);
    const changed = { type: "ticket.changed", data: { projectId: project.id, ticketId: ticket.id } };

    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });
    expect(await stream.next()).toEqual(changed);
    await ok("DELETE", `/api/tickets/${ticket.id}/artifacts/${board.id}`, ada);
    expect(await stream.next()).toEqual(changed);
    stream.close();
  });

  describe("by an Agent", () => {
    /** The Agent `claude-max` running a Triage Run on CRONK-1 through Ada's fake Runner, and a second Ticket CRONK-2. */
    async function runningRun() {
      const setup = await ticketWithArtifacts();
      const { ada, project, ticket, agent } = setup;
      const other = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Something else" });
      const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
      await ok("PATCH", `/api/agents/${agent.id}`, ada, { runnerId: runner.id });
      const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id;
      await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
      const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
      return { ...setup, other, run };
    }

    test("during its Run on the Ticket, an Agent links and unlinks Artifacts, each Change naming its Run", async () => {
      const { ada, ticket, board, tokens, agent, asAgent, run } = await runningRun();

      await ok("POST", `/api/tickets/${ticket.id}/artifacts`, asAgent, { artifactId: board.id });
      await ok("POST", `/api/tickets/${ticket.id}/artifacts`, asAgent, { artifactId: tokens.id });
      await ok("DELETE", `/api/tickets/${ticket.id}/artifacts/${tokens.id}`, asAgent);

      expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, asAgent)).toEqual([expect.objectContaining({ id: board.id })]);
      const changes = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).filter(
        (c: { field: string }) => c.field === "linkedArtifact",
      );
      expect(changes).toHaveLength(3);
      for (const change of changes) {
        expect(change).toEqual(expect.objectContaining({ actor: { kind: "agent", id: agent.id, name: "claude-max" }, runId: run.id }));
      }
    });

    test("an Agent may not link or unlink outside a running Run on the Ticket", async () => {
      const { ada, ticket, other, board, asAgent, run } = await runningRun();
      await ok("POST", `/api/tickets/${other.id}/artifacts`, ada, { artifactId: board.id });

      const onAnotherTicket = await call("POST", `/api/tickets/${other.id}/artifacts`, asAgent, { artifactId: board.id });
      const unlinkOnAnother = await call("DELETE", `/api/tickets/${other.id}/artifacts/${board.id}`, asAgent);
      await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
      const afterItsRun = await call("POST", `/api/tickets/${ticket.id}/artifacts`, asAgent, { artifactId: board.id });

      for (const refused of [onAnotherTicket, unlinkOnAnother, afterItsRun]) {
        expect(refused.status).toBe(403);
        expect(refused.json.error).toEqual(
          expect.objectContaining({ code: "no_running_run", rule: expect.any(String), advice: expect.any(String) }),
        );
      }
      expect(await ok("GET", `/api/tickets/${other.id}/artifacts`, ada)).toEqual([expect.objectContaining({ id: board.id })]);
      expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([]);
    });

    test("an Artifact an Agent creates during its Run is linked to the Run's Ticket, the Change naming the Run", async () => {
      const { workspace, ada, project, ticket, board, agent, asAgent, run } = await runningRun();
      await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: board.id });

      const inProject = await ok("POST", `/api/projects/${project.id}/artifacts`, asAgent, { title: "Drop targets", files, runId: run.id });
      const inWorkspace = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, asAgent, { title: "Spacing", files, runId: run.id });

      expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([
        { id: board.id, projectId: project.id, title: "Board prototype", slug: board.slug },
        { id: inProject.id, projectId: project.id, title: "Drop targets", slug: inProject.slug },
        { id: inWorkspace.id, projectId: null, title: "Spacing", slug: inWorkspace.slug },
      ]);
      const changes = (await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada)).filter(
        (c: { field: string; actor: { kind: string } }) => c.field === "linkedArtifact" && c.actor.kind === "agent",
      );
      expect(changes).toEqual([
        expect.objectContaining({ actor: { kind: "agent", id: agent.id, name: "claude-max" }, runId: run.id, to: { id: inProject.id, title: "Drop targets" } }),
        expect.objectContaining({ runId: run.id, to: { id: inWorkspace.id, title: "Spacing" } }),
      ]);
    });

    test("an Artifact created outside a Run is linked to no Ticket", async () => {
      const { ada, project, ticket, asAgent } = await runningRun();

      await ok("POST", `/api/projects/${project.id}/artifacts`, asAgent, { title: "Drop targets", files });
      await ok("POST", `/api/projects/${project.id}/artifacts`, ada, { title: "Ada's sketch", files });

      expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([]);
    });

    test("creating an Artifact in a Run that isn't the Agent's running one, or in another Project than its Ticket's, is refused and creates nothing", async () => {
      const { workspace, ada, project, ticket, asAgent, run } = await runningRun();
      const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Board", key: "BOARD" });

      const noSuchRun = await call("POST", `/api/projects/${project.id}/artifacts`, asAgent, { title: "A", files, runId: "nope" });
      const byAUser = await call("POST", `/api/projects/${project.id}/artifacts`, ada, { title: "B", files, runId: run.id });
      const elsewhere = await call("POST", `/api/projects/${other.id}/artifacts`, asAgent, { title: "C", files, runId: run.id });
      await ok("POST", `/api/runs/${run.id}/finish`, asAgent, { outcome: "ready" });
      const afterItsRun = await call("POST", `/api/projects/${project.id}/artifacts`, asAgent, { title: "D", files, runId: run.id });

      for (const refused of [noSuchRun, afterItsRun]) {
        expect(refused.status).toBe(403);
        expect(refused.json.error).toEqual(
          expect.objectContaining({ code: "no_running_run", rule: expect.any(String), advice: expect.any(String) }),
        );
      }
      expect(byAUser.status).toBe(400);
      expect(byAUser.json.error.code).toBe("run_for_agents");
      expect(elsewhere.status).toBe(400);
      expect(elsewhere.json.error).toEqual(
        expect.objectContaining({ code: "artifact_outside_project", rule: expect.any(String), advice: expect.any(String) }),
      );
      expect(await ok("GET", `/api/projects/${project.id}/artifacts`, ada)).toEqual([expect.objectContaining({ title: "Board prototype" })]);
      expect(await ok("GET", `/api/projects/${other.id}/artifacts`, ada)).toEqual([]);
      expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([]);
    });

    /** `claude-max`, with no Run, files CRONK-2 as a Discovered Ticket that waits for Ada. */
    async function discovered() {
      const setup = await ticketWithArtifacts();
      const found = await ok("POST", `/api/projects/${setup.project.id}/tickets`, setup.asAgent, { title: "Found it" });
      return { ...setup, found };
    }

    test("outside a Run, an Agent links and unlinks Artifacts on a waiting Discovered Ticket it filed", async () => {
      const { ada, found, board, tokens, agent, asAgent } = await discovered();

      await ok("POST", `/api/tickets/${found.id}/artifacts`, asAgent, { artifactId: board.id });
      await ok("POST", `/api/tickets/${found.id}/artifacts`, asAgent, { artifactId: tokens.id });
      await ok("DELETE", `/api/tickets/${found.id}/artifacts/${tokens.id}`, asAgent);

      expect(await ok("GET", `/api/tickets/${found.id}/artifacts`, ada)).toEqual([expect.objectContaining({ id: board.id })]);
      const changes = (await ok("GET", `/api/tickets/${found.id}/timeline`, ada)).filter(
        (c: { field: string }) => c.field === "linkedArtifact",
      );
      expect(changes.map((c: { actor: { id: string }; runId: string | null }) => [c.actor.id, c.runId])).toEqual([
        [agent.id, null],
        [agent.id, null],
        [agent.id, null],
      ]);
    });

    test("outside a Run, an Agent may not link or unlink on a Ticket it didn't file, or one a User has taken up", async () => {
      const { workspace, ada, ticket, found, board, agent, asAgent } = await discovered();
      const other = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "other" });
      const { secret } = await ok("POST", `/api/agents/${other.id}/tokens`, ada, { name: "t", access: "full" });
      const asOther = { headers: { authorization: `Bearer ${secret}` } };
      await ok("POST", `/api/tickets/${found.id}/artifacts`, asAgent, { artifactId: board.id });

      const onAUsersTicket = await call("POST", `/api/tickets/${ticket.id}/artifacts`, asAgent, { artifactId: board.id });
      const byAnotherAgent = await call("DELETE", `/api/tickets/${found.id}/artifacts/${board.id}`, asOther);
      await ok("PATCH", `/api/tickets/${found.id}`, ada, { delegateId: agent.id });
      const afterDelegated = await call("DELETE", `/api/tickets/${found.id}/artifacts/${board.id}`, asAgent);

      expect(onAUsersTicket.status).toBe(403);
      expect(onAUsersTicket.json.error).toEqual(
        expect.objectContaining({ code: "no_running_run", rule: expect.stringContaining("Discovered Ticket it filed") }),
      );
      for (const refused of [byAnotherAgent, afterDelegated]) {
        expect(refused.status).toBe(403);
        expect(refused.json.error).toEqual(
          expect.objectContaining({
            code: "not_your_discovered_ticket",
            rule: expect.stringContaining("Discovered Ticket it filed"),
            advice: expect.any(String),
          }),
        );
      }
      expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([]);
      expect(await ok("GET", `/api/tickets/${found.id}/artifacts`, ada)).toEqual([expect.objectContaining({ id: board.id })]);
    });

    test("outside a Run, an Agent links Artifacts on a Sub-Ticket of its waiting Discovered Ticket", async () => {
      const { ada, project, found, board, agent, asAgent } = await discovered();
      const half = await ok("POST", `/api/projects/${project.id}/tickets`, asAgent, { title: "Half", parentId: found.id });

      await ok("POST", `/api/tickets/${half.id}/artifacts`, asAgent, { artifactId: board.id });

      expect(await ok("GET", `/api/tickets/${half.id}/artifacts`, ada)).toEqual([expect.objectContaining({ id: board.id })]);
      await ok("PATCH", `/api/tickets/${found.id}`, ada, { delegateId: agent.id });
      const settled = await call("DELETE", `/api/tickets/${half.id}/artifacts/${board.id}`, asAgent);
      expect(settled.json.error.code).toBe("not_your_discovered_ticket");
    });

    test("an Agent links only Artifacts of its Discovered Ticket's Project or of the Workspace", async () => {
      const { workspace, ada, found, asAgent } = await discovered();
      const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Board", key: "BOARD" });
      const elsewhere = await ok("POST", `/api/projects/${other.id}/artifacts`, ada, { title: "Board notes", files });

      const refused = await call("POST", `/api/tickets/${found.id}/artifacts`, asAgent, { artifactId: elsewhere.id });

      expect(refused.status).toBe(400);
      expect(refused.json.error.code).toBe("artifact_outside_project");
    });
  });
});
