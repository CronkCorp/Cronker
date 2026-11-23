import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

/**
 * Releases (CRONK-114): a Project's planned Releases, named by semantic versions, and Tickets tagged with one through
 * the HTTP API and MCP. Nothing reaches GitHub yet.
 */

let cronk: StartedCronk;
const clients: Client[] = [];
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
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

/** Ada with a Project CRONK on the default board, Tickets CRONK-1 and CRONK-2, and Grace listed on it with Read. */
async function withProject() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const grace = await addMember(cronk, ada.cookie, workspace.id, "grace@example.com");
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const first = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Tag me" });
  const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Leave me" });
  await ok("PUT", `/api/projects/${project.id}/access`, ada, {
    visibility: "open",
    users: [{ userId: grace.user.id, level: "read" }],
  });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  return { workspace, ada, grace: { cookie: grace.cookie }, project, first, second, status };
}

/** Ada's Agent running a Triage Run on CRONK-1 through her fake Runner, with its token. */
async function runningRun(setup: Awaited<ReturnType<typeof withProject>>) {
  const { workspace, ada, first, status } = setup;
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  await ok("PATCH", `/api/tickets/${first.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
  const [run] = await ok("GET", `/api/tickets/${first.id}/runs`, ada);
  return { agent, run, secret, asAgent: { headers: { authorization: `Bearer ${secret}` } } };
}

async function connect(token: string) {
  const client = new Client({ name: "cronk-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("/mcp", cronk.url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const [content] = result.content as { type: string; text: string }[];
  return { isError: result.isError ?? false, json: JSON.parse(content!.text) };
}

describe("a Project's Releases", () => {
  test("are created planned, with their release branch, and listed with their Tickets and counts", async () => {
    const { ada, project, first, second, status } = await withProject();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: " v0.3.0 " });
    expect(release).toEqual(
      expect.objectContaining({ name: "v0.3.0", state: "planned", branch: "release/v0.3.0", openCount: 0, doneCount: 0, tickets: [] }),
    );
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0" });
    await ok("PATCH", `/api/tickets/${second.id}`, ada, { release: "V0.3.0", statusId: status("Done") });

    const [listed] = await ok("GET", `/api/projects/${project.id}/releases`, ada);
    expect(listed).toEqual(expect.objectContaining({ id: release.id, openCount: 1, doneCount: 1 }));
    expect(listed.tickets.map((t: { key: string; done: boolean }) => [t.key, t.done])).toEqual([
      ["CRONK-1", false],
      ["CRONK-2", true],
    ]);
  });

  test("refuse a name that isn't a semantic version, or one the Project already has, ignoring case", async () => {
    const { ada, project } = await withProject();
    for (const name of ["0.3", "next", "v1.2.3.4", "1.02.0", "release/v1"]) {
      const refused = await call("POST", `/api/projects/${project.id}/releases`, ada, { name });
      expect(refused.status, name).toBe(400);
      expect(refused.json.error.code).toBe("invalid_release_name");
      expect(refused.json.error.message).toContain("isn't a semantic version");
    }
    for (const name of ["1.2.3", "v1.2.0-rc.1", "2.0.0+build.5"]) {
      await ok("POST", `/api/projects/${project.id}/releases`, ada, { name });
    }
    const taken = await call("POST", `/api/projects/${project.id}/releases`, ada, { name: "v1.2.0-RC.1" });
    expect(taken.status).toBe(409);
    expect(taken.json.error).toEqual(
      expect.objectContaining({ code: "release_name_taken", message: "This Project already has a Release called v1.2.0-rc.1." }),
    );
  });

  test("are renamed while planned, their Tickets staying tagged", async () => {
    const { ada, project, first } = await withProject();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    const other = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.4.0" });
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0" });

    const renamed = await ok("PATCH", `/api/projects/${project.id}/releases/${release.id}`, ada, { name: "v0.3.1" });
    expect(renamed).toEqual(expect.objectContaining({ name: "v0.3.1", branch: "release/v0.3.1" }));
    expect((await ok("GET", `/api/tickets/${first.id}`, ada)).release).toEqual({
      id: release.id,
      name: "v0.3.1",
      state: "planned",
      branch: "release/v0.3.1",
    });
    const taken = await call("PATCH", `/api/projects/${project.id}/releases/${other.id}`, ada, { name: "v0.3.1" });
    expect(taken.json.error.code).toBe("release_name_taken");
    const invalid = await call("PATCH", `/api/projects/${project.id}/releases/${other.id}`, ada, { name: "soon" });
    expect(invalid.json.error.code).toBe("invalid_release_name");
  });

  test("deleting a planned Release untags its Tickets, each timeline recording it", async () => {
    const { ada, project, first, second } = await withProject();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0" });
    await ok("PATCH", `/api/tickets/${second.id}`, ada, { release: "v0.3.0" });

    expect((await call("DELETE", `/api/projects/${project.id}/releases/${release.id}`, ada)).status).toBe(204);

    expect(await ok("GET", `/api/projects/${project.id}/releases`, ada)).toEqual([]);
    for (const ticket of [first, second]) {
      expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).release).toBeNull();
      const timeline = await ok("GET", `/api/tickets/${ticket.id}/timeline`, ada);
      expect(timeline.filter((c: { field: string }) => c.field === "release").map((c: { from: unknown; to: unknown }) => [c.from, c.to])).toEqual([
        [null, { id: release.id, name: "v0.3.0" }],
        [{ id: release.id, name: "v0.3.0" }, null],
      ]);
    }
    expect((await call("DELETE", `/api/projects/${project.id}/releases/${release.id}`, ada)).status).toBe(404);
  });

  test("need Write: a User and an Agent with Read are refused creating, renaming, deleting and tagging", async () => {
    const { workspace, ada, grace, project, first } = await withProject();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, grace, { name: "grace-claude" });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, grace, { name: "laptop", access: "full" });
    const gracesAgent = { headers: { authorization: `Bearer ${secret}` } };

    for (const as of [grace, gracesAgent]) {
      const attempts = [
        await call("POST", `/api/projects/${project.id}/releases`, as, { name: "v0.4.0" }),
        await call("PATCH", `/api/projects/${project.id}/releases/${release.id}`, as, { name: "v0.4.0" }),
        await call("DELETE", `/api/projects/${project.id}/releases/${release.id}`, as),
        await call("PATCH", `/api/tickets/${first.id}`, as, { release: "v0.3.0" }),
      ];
      for (const attempt of attempts) {
        expect(attempt.status).toBe(403);
        expect(attempt.json.error.code).toBe("read_access");
      }
    }
    // Reading still works.
    expect(await ok("GET", `/api/projects/${project.id}/releases`, grace)).toHaveLength(1);
    expect((await ok("GET", `/api/tickets/${first.id}`, ada)).release).toBeNull();
  });

  test("are told live: created, renamed and deleted", async () => {
    const { workspace, ada, project } = await withProject();
    const stream = await openStream(cronk, ada.cookie, workspace.id);
    try {
      const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
      expect(await stream.next()).toEqual({ type: "releases.changed", data: { projectId: project.id } });
      await ok("PATCH", `/api/projects/${project.id}/releases/${release.id}`, ada, { name: "v0.3.1" });
      expect(await stream.next()).toEqual({ type: "releases.changed", data: { projectId: project.id } });
      await ok("DELETE", `/api/projects/${project.id}/releases/${release.id}`, ada);
      expect(await stream.next()).toEqual({ type: "releases.changed", data: { projectId: project.id } });
    } finally {
      stream.close();
    }
  });
});

describe("tagging a Ticket with a Release", () => {
  test("shows it on the Ticket, records it on the timeline and untags with null", async () => {
    const { ada, project, first } = await withProject();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    const other = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.4.0" });

    const tagged = await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0" });
    expect(tagged.release).toEqual({ id: release.id, name: "v0.3.0", state: "planned", branch: "release/v0.3.0" });
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.4.0" });
    const untagged = await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: null });
    expect(untagged.release).toBeNull();

    const timeline = await ok("GET", `/api/tickets/${first.id}/timeline`, ada);
    const changes = timeline.filter((c: { field: string }) => c.field === "release");
    expect(changes.map((c: { from: unknown; to: unknown }) => [c.from, c.to])).toEqual([
      [null, { id: release.id, name: "v0.3.0" }],
      [{ id: release.id, name: "v0.3.0" }, { id: other.id, name: "v0.4.0" }],
      [{ id: other.id, name: "v0.4.0" }, null],
    ]);
  });

  test("refuses a Release the Project doesn't have, naming its planned ones", async () => {
    const { workspace, ada, project, first } = await withProject();
    await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    const elsewhere = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
    await ok("POST", `/api/projects/${elsewhere.id}/releases`, ada, { name: "v9.0.0" });

    for (const name of ["v9.0.0", "v0.3"]) {
      const refused = await call("PATCH", `/api/tickets/${first.id}`, ada, { release: name });
      expect(refused.status).toBe(400);
      expect(refused.json.error).toEqual(
        expect.objectContaining({ code: "unknown_release", advice: "Use one of its planned Releases: v0.3.0." }),
      );
    }
  });

  test("a new Ticket is created tagged, and the list filters by Release, ignoring case, or `none`", async () => {
    const { ada, project, first, second } = await withProject();
    await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0" });
    const third = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Born tagged", release: "v0.3.0" });
    expect(third.release.name).toBe("v0.3.0");
    const timeline = await ok("GET", `/api/tickets/${third.id}/timeline`, ada);
    expect(timeline.map((c: { field: string }) => c.field)).toEqual(["created", "release"]);

    const keys = async (query: string) =>
      (await ok("GET", `/api/projects/${project.id}/tickets?${query}`, ada)).map((t: { key: string }) => t.key);
    expect(await keys("release=V0.3.0")).toEqual(["CRONK-1", "CRONK-3"]);
    expect(await keys("release=none")).toEqual([second.key]);
    expect(await keys("release=v0.4.0")).toEqual([]);
  });

  test("an Agent tags its Run's Ticket, and files and finds tagged Tickets, through MCP", async () => {
    const setup = await withProject();
    const { ada, project, first } = setup;
    await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    const { run, secret } = await runningRun(setup);
    const client = await connect(secret);

    const edited = await tool(client, "edit_ticket", { ticket: "CRONK-1", release: "v0.3.0" });
    expect(edited.isError).toBe(false);
    expect(edited.json.release).toEqual(expect.objectContaining({ name: "v0.3.0", branch: "release/v0.3.0" }));
    const filed = await tool(client, "file_ticket", { project: "CRONK", title: "Found on the way", release: "v0.3.0", run: run.id });
    expect(filed.isError).toBe(false);
    expect(filed.json.release.name).toBe("v0.3.0");

    const listed = await tool(client, "list_tickets", { project: "CRONK", release: "v0.3.0" });
    // In board order: the Discovered Ticket waits in Backlog, before CRONK-1 in Triage.
    expect(listed.json.map((t: { key: string; release: string }) => [t.key, t.release])).toEqual([
      [filed.json.key, "v0.3.0"],
      ["CRONK-1", "v0.3.0"],
    ]);
    const read = await tool(client, "read_ticket", { ticket: "CRONK-1" });
    expect(read.json.ticket.release).toEqual(expect.objectContaining({ name: "v0.3.0", state: "planned", branch: "release/v0.3.0" }));

    const timeline = await ok("GET", `/api/tickets/${first.id}/timeline`, ada);
    const tagging = timeline.find((c: { field: string }) => c.field === "release");
    expect(tagging).toEqual(expect.objectContaining({ runId: run.id, actor: expect.objectContaining({ kind: "agent" }) }));

    const unknown = await tool(client, "edit_ticket", { ticket: "CRONK-1", release: "v1.0.0" });
    expect(unknown.isError).toBe(true);
    expect(unknown.json.code).toBe("unknown_release");
  });
});
