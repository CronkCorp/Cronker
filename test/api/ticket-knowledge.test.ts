import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * A Ticket's knowledge (CRONK-70): reading a Ticket gives the Terms and Decisions its description and Comments
 * mention, from the Mention index, each once, as far as the reader may read them, the Project's Term over the
 * Workspace's of the same name.
 */

let cronk: StartedCronk;
afterEach(async () => {
  await cronk?.stop();
});

interface As {
  cookie?: string;
}

async function ok(method: string, path: string, as: As, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  const json = response.status === 204 ? null : await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
}

/** Ada with a Project CRONK. */
async function workspaceWithProject() {
  cronk = await startCronk();
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  return { workspace, ada, project };
}

type Setting = Awaited<ReturnType<typeof workspaceWithProject>>;

const ticket = (s: Setting, description: string, projectId = s.project.id) =>
  ok("POST", `/api/projects/${projectId}/tickets`, s.ada, { title: "Do", description });
const knowledge = async (id: string, as: As) => (await ok("GET", `/api/tickets/${id}`, as)).knowledge;

describe("a Ticket's knowledge", () => {
  test("lists the Terms and Decisions its description and Comments mention, each once, Decisions without bodies", async () => {
    const s = await workspaceWithProject();
    const lane = await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, {
      name: "Lane",
      definition: "A column of the board.",
      avoid: ["Swimlane"],
    });
    const run = await ok("POST", `/api/workspaces/${s.workspace.id}/terms`, s.ada, { name: "Run", definition: "One go." });
    const runs = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "One Run", body: "Secret reasons." });
    const own = await ok("POST", `/api/workspaces/${s.workspace.id}/decisions`, s.ada, { title: "Hosting", body: "Why." });
    await cronk.jobsSettled();
    const written = await ticket(s, "Each Lane follows CRONK-D1, and a Lane again with cronk-d1.");
    await ok("POST", `/api/tickets/${written.id}/comments`, s.ada, { body: "A Run per Lane, as D1 says." });
    await ok("POST", `/api/tickets/${written.id}/comments`, s.ada, { body: "Another Run, by CRONK-D1." });

    expect(await knowledge(written.id, s.ada)).toEqual({
      terms: [
        {
          id: lane.id,
          name: "Lane",
          definition: "A column of the board.",
          avoid: ["Swimlane"],
          scope: "project",
          projectId: s.project.id,
        },
        { id: run.id, name: "Run", definition: "One go.", avoid: [], scope: "workspace", projectId: null },
      ],
      decisions: [
        { id: runs.id, key: "CRONK-D1", title: "One Run", status: "proposed", scope: "project", projectId: s.project.id },
        { id: own.id, key: "D1", title: "Hosting", status: "proposed", scope: "workspace", projectId: null },
      ],
    });
  });

  test("is empty for a Ticket mentioning none, and follows a Term's rename and removal", async () => {
    const s = await workspaceWithProject();
    const lane = await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name: "Lane", definition: "" });
    await cronk.jobsSettled();
    expect(await knowledge((await ticket(s, "Nothing named.")).id, s.ada)).toEqual({ terms: [], decisions: [] });
    const written = await ticket(s, "A Lane and a Column.");
    expect((await knowledge(written.id, s.ada)).terms.map((term: { id: string }) => term.id)).toEqual([lane.id]);

    await ok("PATCH", `/api/terms/${lane.id}`, s.ada, { baseVersion: 1, name: "Column" });
    await cronk.jobsSettled();
    expect((await knowledge(written.id, s.ada)).terms).toEqual([expect.objectContaining({ id: lane.id, name: "Column" })]);

    await ok("DELETE", `/api/terms/${lane.id}`, s.ada);
    await cronk.jobsSettled();
    expect((await knowledge(written.id, s.ada)).terms).toEqual([]);
  });

  test("gives the Project's Term over the Workspace's of the same name", async () => {
    const s = await workspaceWithProject();
    const other = await ok("POST", `/api/workspaces/${s.workspace.id}/projects`, s.ada, { name: "Web", key: "WEB" });
    const workspaceLane = await ok("POST", `/api/workspaces/${s.workspace.id}/terms`, s.ada, { name: "Lane", definition: "Any." });
    const projectLane = await ok("POST", `/api/projects/${s.project.id}/terms`, s.ada, { name: "Lane", definition: "Ours." });
    await cronk.jobsSettled();

    const inProject = await ticket(s, "A Lane.");
    const elsewhere = await ticket(s, "A Lane.", other.id);

    expect((await knowledge(inProject.id, s.ada)).terms).toEqual([
      expect.objectContaining({ id: projectLane.id, definition: "Ours.", scope: "project" }),
    ]);
    expect((await knowledge(elsewhere.id, s.ada)).terms).toEqual([
      expect.objectContaining({ id: workspaceLane.id, definition: "Any.", scope: "workspace" }),
    ]);
  });

  test("leaves out what the reader can't read", async () => {
    const s = await workspaceWithProject();
    const grace = await addMember(cronk, s.ada.cookie!, s.workspace.id, "grace@example.com");
    const bea = await addMember(cronk, s.ada.cookie!, s.workspace.id, "bea@example.com");
    const secret = await ok("POST", `/api/workspaces/${s.workspace.id}/projects`, s.ada, { name: "Secret", key: "SECRET" });
    await ok("PUT", `/api/projects/${secret.id}/access`, s.ada, {
      visibility: "private",
      users: [{ userId: bea.user.id, level: "read" }],
    });
    const hidden = await ok("POST", `/api/projects/${secret.id}/decisions`, s.ada, { title: "Hidden", body: "" });
    const shown = await ok("POST", `/api/projects/${s.project.id}/decisions`, s.ada, { title: "Shown", body: "" });
    const written = await ticket(s, "By SECRET-D1 and CRONK-D1.");

    const keys = async (as: As) => (await knowledge(written.id, as)).decisions.map((d: { id: string }) => d.id);
    expect(await keys(s.ada)).toEqual([hidden.id, shown.id]);
    expect(await keys({ cookie: bea.cookie })).toEqual([hidden.id, shown.id]);
    expect(await keys({ cookie: grace.cookie })).toEqual([shown.id]);
  });
});
