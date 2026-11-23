import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream, type OpenStream } from "../harness/stream.js";

/**
 * Archiving a Project (CRONK-75): an Admin archives it, making it read-only for everyone, Admins and Agents included,
 * until an Admin unarchives it. Reads, its key and its addresses keep working.
 */

let cronk: StartedCronk;
let streams: OpenStream[];
beforeEach(async () => {
  cronk = await startCronk();
  streams = [];
});
afterEach(async () => {
  for (const stream of streams) stream.close();
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

async function attach(path: string, as: As) {
  const response = await fetch(new URL(`${path}?name=log.txt`, cronk.url), {
    method: "POST",
    headers: { ...as.headers, ...(as.cookie ? { cookie: as.cookie } : {}), "content-type": "text/plain" },
    body: "a log",
  });
  return { status: response.status, json: await response.json() };
}

/** Ada, the Admin; Grace, a member with Write; a Project CRONK with a Ticket and a Document; and Ada's Agent. */
async function withProject() {
  const { workspace, user } = await setUp(cronk);
  const ada = { id: user.id, cookie: await signIn(cronk) };
  const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Ship it" });
  const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plan" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "write" });
  const claude = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, ada, grace, project, ticket, document, claude };
}

describe("archiving a Project", () => {
  test("only an Admin archives and unarchives; it says when and who", async () => {
    const { ada, grace, project, claude } = await withProject();

    for (const as of [grace, claude]) {
      const refused = await call("POST", `/api/projects/${project.id}/archive`, as);
      expect(refused.status).toBeGreaterThanOrEqual(401);
      expect(refused.status).toBeLessThanOrEqual(403);
    }
    expect((await call("POST", `/api/projects/${project.id}/archive`, grace)).json.error.code).toBe("not_admin");

    const archived = await ok("POST", `/api/projects/${project.id}/archive`, ada);
    expect(archived).toEqual(expect.objectContaining({ id: project.id, archivedBy: ada.id, access: "read" }));
    expect(new Date(archived.archivedAt).getTime()).not.toBeNaN();
    const again = await call("POST", `/api/projects/${project.id}/archive`, ada);
    expect([again.status, again.json.error.code]).toEqual([409, "project_already_archived"]);

    expect((await call("POST", `/api/projects/${project.id}/unarchive`, grace)).json.error.code).toBe("not_admin");
    const unarchived = await ok("POST", `/api/projects/${project.id}/unarchive`, ada);
    expect(unarchived).toEqual(expect.objectContaining({ archivedAt: null, archivedBy: null, access: "write" }));
    const notArchived = await call("POST", `/api/projects/${project.id}/unarchive`, ada);
    expect([notArchived.status, notArchived.json.error.code]).toEqual([409, "project_not_archived"]);
  });

  test("refuses every write in it with project_archived, for Users, Admins and Agents alike", async () => {
    const { ada, grace, project, ticket, document, claude } = await withProject();
    const status = project.statuses[0];
    await ok("POST", `/api/projects/${project.id}/archive`, ada);

    const writes: [string, string, unknown?][] = [
      ["POST", `/api/projects/${project.id}/tickets`, { title: "More" }],
      ["PATCH", `/api/tickets/${ticket.id}`, { title: "Renamed" }],
      ["POST", `/api/tickets/${ticket.id}/comments`, { body: "Still here?" }],
      ["POST", `/api/projects/${project.id}/documents`, { title: "Another" }],
      ["POST", `/api/projects/${project.id}/terms`, { name: "Run" }],
      [
        "POST",
        `/api/projects/${project.id}/artifacts`,
        { title: "Page", files: [{ path: "index.html", contentBase64: btoa("<p>hi</p>") }] },
      ],
      ["POST", `/api/projects/${project.id}/statuses`, { name: "Mine", kind: "active" }],
      ["PATCH", `/api/projects/${project.id}/statuses/${status.id}`, { name: "Renamed" }],
      ["PATCH", `/api/projects/${project.id}`, { conciseReports: true }],
      ["PUT", `/api/projects/${project.id}/access`, { visibility: "private", users: [] }],
    ];
    for (const as of [ada, grace, claude]) {
      for (const [method, path, body] of writes) {
        const refused = await call(method, path, as, body);
        // Project settings are for Users and Access for Admins: others are refused before the archive is asked about.
        if (as === claude && path === `/api/projects/${project.id}`) continue;
        if (as !== ada && path.endsWith("/access")) continue;
        expect(refused.status, `${method} ${path}`).toBe(403);
        expect(refused.json.error, `${method} ${path}`).toEqual(
          expect.objectContaining({ code: "project_archived", rule: expect.any(String), advice: expect.any(String) }),
        );
      }
      const attached = await attach(`/api/tickets/${ticket.id}/attachments`, as);
      expect([attached.status, attached.json.error.code]).toEqual([403, "project_archived"]);
    }
    const saved = await call("PATCH", `/api/documents/${document.id}`, grace, { baseVersion: 1, title: "Plan B" });
    expect([saved.status, saved.json.error.code]).toEqual([403, "project_archived"]);
  });

  test("keeps reads, its key and its addresses working", async () => {
    const { workspace, ada, grace, project, ticket, document, claude } = await withProject();
    await ok("POST", `/api/projects/${project.id}/archive`, ada);

    for (const as of [ada, grace, claude]) {
      for (const path of [
        `/api/projects/${project.id}`,
        `/api/projects/${project.id}/tickets`,
        `/api/tickets/${ticket.id}`,
        `/api/tickets/${ticket.id}/comments`,
        `/api/workspaces/${workspace.id}/tickets/CRONK-1`,
        `/api/documents/${document.id}`,
      ]) {
        expect((await call("GET", path, as)).status, path).toBe(200);
      }
    }
  });

  test("lists it among the Workspace's Projects, archived, and unarchiving gives Write back", async () => {
    const { workspace, ada, grace, project, ticket, claude } = await withProject();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
    await ok("POST", `/api/projects/${project.id}/archive`, ada);

    for (const as of [ada, grace, claude]) {
      const projects = await ok("GET", `/api/workspaces/${workspace.id}/projects`, as);
      expect(projects.map((p: { key: string; archivedAt: string | null; access: string }) => [p.key, p.archivedAt !== null, p.access])).toEqual([
        ["CRONK", true, "read"],
        ["OTHER", false, "write"],
      ]);
    }
    expect(other.archivedAt).toBeNull();

    await ok("POST", `/api/projects/${project.id}/unarchive`, ada);
    for (const as of [ada, grace, claude]) {
      await ok("POST", `/api/tickets/${ticket.id}/comments`, as, { body: "Back again." });
    }
    await ok("PATCH", `/api/tickets/${ticket.id}`, grace, { title: "Renamed" });
  });

  test("tells everyone who reads it, live, when it is archived and unarchived", async () => {
    const { workspace, ada, grace, project } = await withProject();
    const [adas, graces] = [await openStream(cronk, ada.cookie, workspace.id), await openStream(cronk, grace.cookie, workspace.id)];
    streams.push(adas, graces);

    await ok("POST", `/api/projects/${project.id}/archive`, ada);
    await ok("POST", `/api/projects/${project.id}/unarchive`, ada);

    for (const stream of [adas, graces]) {
      expect(await stream.next()).toEqual({ type: "project.changed", data: { projectId: project.id } });
      expect(await stream.next()).toEqual({ type: "project.changed", data: { projectId: project.id } });
      await stream.expectQuiet();
    }
  });
});
