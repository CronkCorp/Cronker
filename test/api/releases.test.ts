import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, setUp, signIn } from "../harness/flows.js";
import { branchesOf, tagsOf } from "../harness/github.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

/**
 * Releases (CRONK-114): a Project's planned Releases, named by semantic versions, and Tickets tagged with one through
 * the HTTP API and MCP. Cutting one (CRONK-115) creates its release branch in each of the Project's Repositories, and
 * releasing it (CRONK-118) tags each release branch's head and creates a GitHub Release in each.
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
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
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
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, grace, { name: "laptop", access: "write" });
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

/** `withProject`, with the GitHub App installed on `cronkcorp`'s `cronker` and `website`, both listed on CRONK. */
async function withRepositories() {
  const setup = await withProject();
  const { ada, project } = setup;
  await createGitHubApp(cronk, ada.cookie!);
  const installation = cronk.github.install(cronk.github.apps[0]!, "cronkcorp", ["cronker", "website"]);
  const [cronker, website] = [installation.repositories[0]!, installation.repositories[1]!];
  for (const repository of [cronker, website]) {
    await ok("POST", `/api/projects/${project.id}/repositories`, ada, { id: repository.id });
  }
  return { ...setup, installation, cronker, website };
}

const cut = (projectId: string, releaseId: string, as: As) => call("POST", `/api/projects/${projectId}/releases/${releaseId}/cut`, as);

describe("cutting a Release", () => {
  test("creates release/<name> at the default branch's head in each Repository, and records the commits", async () => {
    const { ada, project, first, cronker, website } = await withRepositories();
    website.defaultBranch = "trunk";
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0" });
    const [cronkerHead, websiteHead] = [branchesOf(cronker).get("main")!, branchesOf(website).get("trunk")!];

    const answer = await cut(project.id, release.id, ada);

    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    expect(answer.json).toEqual(
      expect.objectContaining({
        state: "cut",
        cutBy: expect.objectContaining({ name: expect.any(String) }),
        cutAt: expect.any(String),
        repositories: [
          { repository: { id: cronker.id, fullName: "cronkcorp/cronker" }, commit: cronkerHead, tag: null, releaseUrl: null },
          { repository: { id: website.id, fullName: "cronkcorp/website" }, commit: websiteHead, tag: null, releaseUrl: null },
        ],
      }),
    );
    expect(cronk.github.refsCreated).toEqual([
      { repository: "cronkcorp/cronker", ref: "refs/heads/release/v0.3.0", sha: cronkerHead },
      { repository: "cronkcorp/website", ref: "refs/heads/release/v0.3.0", sha: websiteHead },
    ]);
    const [listed] = await ok("GET", `/api/projects/${project.id}/releases`, ada);
    expect(listed).toEqual(answer.json);
    expect((await ok("GET", `/api/tickets/${first.id}`, ada)).release.state).toBe("cut");
  });

  test("one existing release branch refuses the whole Cut, naming it, and nothing is created", async () => {
    const { ada, project, website } = await withRepositories();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    branchesOf(website).set("release/v0.3.0", "0".repeat(40));

    const refused = await cut(project.id, release.id, ada);

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(
      expect.objectContaining({
        code: "release_branch_exists",
        message: "release/v0.3.0 already exists in cronkcorp/website, so v0.3.0 wasn't cut and no branch was created.",
      }),
    );
    expect(cronk.github.refsCreated).toEqual([]);
    expect(cronk.github.apiCalls.filter((c) => c.startsWith("POST /repos/"))).toEqual([]);
    const [listed] = await ok("GET", `/api/projects/${project.id}/releases`, ada);
    expect(listed).toEqual(expect.objectContaining({ state: "planned", cutBy: null, cutAt: null, repositories: [] }));
  });

  test("needs a User with Write and a planned Release", async () => {
    const { workspace, ada, grace, project } = await withRepositories();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "write" });

    const byGrace = await cut(project.id, release.id, grace);
    expect([byGrace.status, byGrace.json.error.code]).toEqual([403, "read_access"]);
    const byAgent = await cut(project.id, release.id, { headers: { authorization: `Bearer ${secret}` } });
    expect([byAgent.status, byAgent.json.error.code]).toEqual([403, "agent_not_allowed"]);
    expect(cronk.github.refsCreated).toEqual([]);

    await ok("POST", `/api/projects/${project.id}/releases/${release.id}/cut`, ada);
    const again = await cut(project.id, release.id, ada);
    expect(again.status).toBe(409);
    expect(again.json.error).toEqual(expect.objectContaining({ code: "release_not_planned", message: "v0.3.0 is cut, so it can't be cut." }));
    expect(cronk.github.refsCreated).toHaveLength(2);
  });

  test("a Project with no Repositories refuses with the reason", async () => {
    const { ada, project } = await withProject();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });

    const refused = await cut(project.id, release.id, ada);

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(
      expect.objectContaining({
        code: "no_repositories",
        message: "CRONK lists no Repositories, so there is nowhere to cut release/v0.3.0.",
        advice: expect.stringContaining("Add the Project's Repositories"),
      }),
    );
  });

  test("a Repository the App no longer covers refuses the whole Cut", async () => {
    const { ada, project, installation, website } = await withRepositories();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    installation.repositories.splice(installation.repositories.indexOf(website), 1);

    const refused = await cut(project.id, release.id, ada);

    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("repository_not_installed");
    expect(refused.json.error.message).toContain("cronkcorp/website");
    expect(cronk.github.refsCreated).toEqual([]);
  });

  test("a cut Release can't be renamed, deleted or given more Tickets, and its Tickets stay tagged", async () => {
    const { ada, project, first, second } = await withRepositories();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0" });
    await ok("POST", `/api/projects/${project.id}/releases/${release.id}/cut`, ada);

    const attempts = [
      await call("PATCH", `/api/projects/${project.id}/releases/${release.id}`, ada, { name: "v0.3.1" }),
      await call("DELETE", `/api/projects/${project.id}/releases/${release.id}`, ada),
      await call("PATCH", `/api/tickets/${second.id}`, ada, { release: "v0.3.0" }),
      await call("PATCH", `/api/tickets/${first.id}`, ada, { release: null }),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(409);
      expect(attempt.json.error.code).toBe("release_not_planned");
    }
    expect((await ok("GET", `/api/tickets/${first.id}`, ada)).release.name).toBe("v0.3.0");
  });

  test("is told live", async () => {
    const { workspace, ada, project } = await withRepositories();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    const stream = await openStream(cronk, ada.cookie!, workspace.id);
    try {
      await ok("POST", `/api/projects/${project.id}/releases/${release.id}/cut`, ada);
      expect(await stream.next()).toEqual({ type: "releases.changed", data: { projectId: project.id } });
    } finally {
      stream.close();
    }
  });
});

const publish = (projectId: string, releaseId: string, as: As, body: { upgradeNotes?: string; confirm?: boolean } = {}) =>
  call("POST", `/api/projects/${projectId}/releases/${releaseId}/release`, as, body);

/** `withRepositories`, with v0.3.0 cut and CRONK-1 (Done) and CRONK-2 tagged with it. */
async function withCutRelease() {
  const setup = await withRepositories();
  const { ada, project, first, second, status } = setup;
  const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
  await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0", statusId: status("Done") });
  await ok("PATCH", `/api/tickets/${second.id}`, ada, { release: "v0.3.0", title: "Ship the Releases page" });
  await ok("POST", `/api/projects/${project.id}/releases/${release.id}/cut`, ada);
  return { ...setup, release };
}

describe("releasing a Release", () => {
  test("with open Tickets is refused, listing them, and nothing is created; `confirm` goes ahead", async () => {
    const { ada, project, release } = await withCutRelease();

    const refused = await publish(project.id, release.id, ada, { upgradeNotes: "Run the migration." });

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(
      expect.objectContaining({
        code: "release_has_open_tickets",
        message: "v0.3.0 has an open Ticket: CRONK-2 Ship the Releases page (Backlog).",
        openTickets: [{ key: "CRONK-2", title: "Ship the Releases page", status: "Backlog" }],
      }),
    );
    expect(cronk.github.refsCreated.filter((r) => r.ref.startsWith("refs/tags/"))).toEqual([]);
    expect(cronk.github.releasesCreated).toEqual([]);
    expect((await ok("GET", `/api/projects/${project.id}/releases`, ada))[0].state).toBe("cut");

    const released = await publish(project.id, release.id, ada, { upgradeNotes: "Run the migration.", confirm: true });
    expect(released.status, JSON.stringify(released.json)).toBe(200);
    expect(released.json.state).toBe("released");
  });

  test("tags each release branch's head and creates a GitHub Release with the notes in each Repository", async () => {
    const { ada, project, release, cronker, website } = await withCutRelease();
    // A backport landed on one release branch after the Cut: Release tags the head, not the cut commit.
    branchesOf(website).set("release/v0.3.0", "b".repeat(40));
    const cronkerHead = branchesOf(cronker).get("release/v0.3.0")!;

    const answer = await publish(project.id, release.id, ada, { upgradeNotes: "  Run `npm run migrate` first.\n", confirm: true });

    expect(answer.status, JSON.stringify(answer.json)).toBe(200);
    const notes =
      "## Upgrade notes\n\nRun `npm run migrate` first.\n\n## Tickets\n\n- CRONK-1: Tag me\n- CRONK-2: Ship the Releases page\n";
    expect(cronk.github.refsCreated.filter((r) => r.ref.startsWith("refs/tags/"))).toEqual([
      { repository: "cronkcorp/cronker", ref: "refs/tags/v0.3.0", sha: cronkerHead },
      { repository: "cronkcorp/website", ref: "refs/tags/v0.3.0", sha: "b".repeat(40) },
    ]);
    const published = (repository: string) => ({
      repository,
      tag: "v0.3.0",
      name: "v0.3.0",
      body: notes,
      url: `https://github.com/${repository}/releases/tag/v0.3.0`,
    });
    expect(cronk.github.releasesCreated).toEqual([published("cronkcorp/cronker"), published("cronkcorp/website")]);
    expect(answer.json).toEqual(
      expect.objectContaining({
        state: "released",
        releasedBy: expect.objectContaining({ name: expect.any(String) }),
        releasedAt: expect.any(String),
        upgradeNotes: "Run `npm run migrate` first.",
      }),
    );
    expect(answer.json.repositories.map((r: { tag: string; releaseUrl: string }) => [r.tag, r.releaseUrl])).toEqual([
      ["v0.3.0", "https://github.com/cronkcorp/cronker/releases/tag/v0.3.0"],
      ["v0.3.0", "https://github.com/cronkcorp/website/releases/tag/v0.3.0"],
    ]);
    const [listed] = await ok("GET", `/api/projects/${project.id}/releases`, ada);
    expect(listed).toEqual(answer.json);
  });

  test("without Upgrade notes, the notes list only the Tickets", async () => {
    const { ada, project, second, status, release } = await withCutRelease();
    await ok("PATCH", `/api/tickets/${second.id}`, ada, { statusId: status("Done") });

    await ok("POST", `/api/projects/${project.id}/releases/${release.id}/release`, ada, { upgradeNotes: "   " });

    expect(cronk.github.releasesCreated[0]!.body).toBe("## Tickets\n\n- CRONK-1: Tag me\n- CRONK-2: Ship the Releases page\n");
    expect((await ok("GET", `/api/projects/${project.id}/releases`, ada))[0].upgradeNotes).toBeNull();
  });

  test("a released Release refuses tagging and untagging Tickets, and can't be cut, renamed, deleted or released again", async () => {
    const { ada, project, first, release } = await withCutRelease();
    const third = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Too late" });
    await ok("POST", `/api/projects/${project.id}/releases/${release.id}/release`, ada, { confirm: true });

    const attempts = [
      await call("PATCH", `/api/tickets/${third.id}`, ada, { release: "v0.3.0" }),
      await call("PATCH", `/api/tickets/${first.id}`, ada, { release: null }),
      await call("PATCH", `/api/projects/${project.id}/releases/${release.id}`, ada, { name: "v0.3.1" }),
      await call("DELETE", `/api/projects/${project.id}/releases/${release.id}`, ada),
      await cut(project.id, release.id, ada),
    ];
    for (const attempt of attempts) {
      expect(attempt.status).toBe(409);
      expect(attempt.json.error.code).toBe("release_not_planned");
      expect(attempt.json.error.message).toContain("v0.3.0 is released");
    }
    const again = await publish(project.id, release.id, ada, { confirm: true });
    expect([again.status, again.json.error.code]).toEqual([409, "release_not_cut"]);
    expect((await ok("GET", `/api/tickets/${first.id}`, ada)).release.state).toBe("released");
    expect(cronk.github.releasesCreated).toHaveLength(2);
  });

  test("needs a User with Write and a cut Release", async () => {
    const { workspace, ada, grace, project, release } = await withCutRelease();
    const planned = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.4.0" });
    const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "write" });

    const byGrace = await publish(project.id, release.id, grace, { confirm: true });
    expect([byGrace.status, byGrace.json.error.code]).toEqual([403, "read_access"]);
    const byAgent = await publish(project.id, release.id, { headers: { authorization: `Bearer ${secret}` } }, { confirm: true });
    expect([byAgent.status, byAgent.json.error.code]).toEqual([403, "agent_not_allowed"]);
    const notCut = await publish(project.id, planned.id, ada, { confirm: true });
    expect(notCut.status).toBe(409);
    expect(notCut.json.error).toEqual(
      expect.objectContaining({ code: "release_not_cut", message: "v0.4.0 is planned, so it can't be released." }),
    );
    expect(cronk.github.releasesCreated).toEqual([]);
  });

  test("an existing tag or a missing release branch in any Repository refuses the whole Release", async () => {
    const { ada, project, release, cronker, website } = await withCutRelease();
    tagsOf(website).set("v0.3.0", "0".repeat(40));

    const tagged = await publish(project.id, release.id, ada, { confirm: true });
    expect(tagged.status).toBe(409);
    expect(tagged.json.error).toEqual(
      expect.objectContaining({
        code: "release_tag_exists",
        message: "The tag v0.3.0 already exists in cronkcorp/website, so v0.3.0 wasn't released and nothing was created.",
      }),
    );

    tagsOf(website).clear();
    branchesOf(cronker).delete("release/v0.3.0");
    const missing = await publish(project.id, release.id, ada, { confirm: true });
    expect(missing.status).toBe(409);
    expect(missing.json.error.code).toBe("release_branch_missing");
    expect(missing.json.error.message).toContain("cronkcorp/cronker");

    expect(cronk.github.refsCreated.filter((r) => r.ref.startsWith("refs/tags/"))).toEqual([]);
    expect(cronk.github.releasesCreated).toEqual([]);
    expect((await ok("GET", `/api/projects/${project.id}/releases`, ada))[0].state).toBe("cut");
  });

  test("GitHub failing partway leaves the Release cut and names what was already created", async () => {
    const { ada, project, release } = await withCutRelease();
    cronk.github.failingReleases.add("cronkcorp/website");

    const failed = await publish(project.id, release.id, ada, { confirm: true });

    expect(failed.status).toBe(502);
    expect(failed.json.error.code).toBe("release_publish_failed");
    expect(failed.json.error.message).toContain(
      "Already created: the tag in cronkcorp/cronker, the GitHub Release in cronkcorp/cronker, the tag in cronkcorp/website.",
    );
    expect((await ok("GET", `/api/projects/${project.id}/releases`, ada))[0]).toEqual(
      expect.objectContaining({ state: "cut", releasedAt: null, releasedBy: null }),
    );
  });

  test("is told live", async () => {
    const { workspace, ada, project, release } = await withCutRelease();
    const stream = await openStream(cronk, ada.cookie!, workspace.id);
    try {
      await ok("POST", `/api/projects/${project.id}/releases/${release.id}/release`, ada, { confirm: true });
      expect(await stream.next()).toEqual({ type: "releases.changed", data: { projectId: project.id } });
    } finally {
      stream.close();
    }
  });
});

describe("managing Releases through MCP", () => {
  test("an Agent with Write lists, creates, renames and deletes planned Releases, by name", async () => {
    const { workspace, ada, project, first } = await withProject();
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret } = await ok("POST", `/api/agents/${created.id}/tokens`, ada, { name: "laptop", access: "write" });
    const client = await connect(secret);

    const made = await tool(client, "create_release", { project: "cronk", name: " v0.3.0 " });
    expect(made.isError).toBe(false);
    expect(made.json).toEqual(expect.objectContaining({ name: "v0.3.0", state: "planned", branch: "release/v0.3.0" }));
    await ok("PATCH", `/api/tickets/${first.id}`, ada, { release: "v0.3.0" });

    const listed = await tool(client, "list_releases", { project: "CRONK" });
    expect(listed.json).toEqual([
      expect.objectContaining({ id: made.json.id, name: "v0.3.0", state: "planned", branch: "release/v0.3.0", openCount: 1 }),
    ]);

    const renamed = await tool(client, "rename_release", { project: "CRONK", release: "V0.3.0", name: "v0.3.1" });
    expect(renamed.json).toEqual(expect.objectContaining({ id: made.json.id, name: "v0.3.1", branch: "release/v0.3.1" }));
    expect((await tool(client, "read_ticket", { ticket: "CRONK-1" })).json.ticket.release).toEqual({
      id: made.json.id,
      name: "v0.3.1",
      state: "planned",
      branch: "release/v0.3.1",
    });

    const deleted = await tool(client, "delete_release", { project: "CRONK", release: "v0.3.1" });
    expect(deleted).toEqual({ isError: false, json: { deleted: "v0.3.1" } });
    expect((await tool(client, "list_releases", { project: "CRONK" })).json).toEqual([]);
    expect((await ok("GET", `/api/tickets/${first.id}`, ada)).release).toBeNull();
  });

  test("refusals match the API's: a taken or invalid name, an unknown Release, and Read or a read-only token", async () => {
    const { workspace, ada, grace, project } = await withProject();
    await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.4.0" });
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret } = await ok("POST", `/api/agents/${created.id}/tokens`, ada, { name: "laptop", access: "write" });
    const client = await connect(secret);

    for (const [name, args, code] of [
      ["create_release", { project: "CRONK", name: "v0.3.0" }, "release_name_taken"],
      ["create_release", { project: "CRONK", name: "soon" }, "invalid_release_name"],
      ["rename_release", { project: "CRONK", release: "v0.4.0", name: "v0.3.0" }, "release_name_taken"],
      ["rename_release", { project: "CRONK", release: "v0.4.0", name: "next" }, "invalid_release_name"],
      ["rename_release", { project: "CRONK", release: "v9.9.9", name: "v1.0.0" }, "unknown_release"],
      ["delete_release", { project: "CRONK", release: "v9.9.9" }, "unknown_release"],
    ] as const) {
      const refused = await tool(client, name, args);
      expect(refused, `${name} ${JSON.stringify(args)}`).toEqual({ isError: true, json: expect.objectContaining({ code }) });
    }
    const taken = await tool(client, "create_release", { project: "CRONK", name: "v0.3.0" });
    expect(taken.json.message).toBe("This Project already has a Release called v0.3.0.");
    const unknown = await tool(client, "delete_release", { project: "CRONK", release: "v9.9.9" });
    expect(unknown.json.advice).toBe("Use one of its Releases: v0.3.0, v0.4.0.");

    // Grace's Agent, whose Owner has Read, and a read-only token of Ada's Agent read but don't write.
    const gracesAgent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, grace, { name: "grace-claude" });
    const { secret: graceSecret } = await ok("POST", `/api/agents/${gracesAgent.id}/tokens`, grace, { name: "laptop", access: "write" });
    const { secret: readOnly } = await ok("POST", `/api/agents/${created.id}/tokens`, ada, { name: "reader", access: "read" });
    for (const [token, code] of [
      [graceSecret, "read_access"],
      [readOnly, "read_only_token"],
    ] as const) {
      const reader = await connect(token);
      expect((await tool(reader, "list_releases", { project: "CRONK" })).json).toHaveLength(2);
      for (const [name, args] of [
        ["create_release", { project: "CRONK", name: "v0.5.0" }],
        ["rename_release", { project: "CRONK", release: "v0.3.0", name: "v0.3.1" }],
        ["delete_release", { project: "CRONK", release: "v0.3.0" }],
      ] as const) {
        const refused = await tool(reader, name, args);
        expect(refused, `${code} ${name}`).toEqual({ isError: true, json: expect.objectContaining({ code }) });
      }
    }
    expect((await ok("GET", `/api/projects/${project.id}/releases`, ada)).map((r: { name: string }) => r.name)).toEqual([
      "v0.3.0",
      "v0.4.0",
    ]);
  });

  test("a cut Release is neither renamed nor deleted, and no tool cuts or releases one", async () => {
    const { workspace, ada, project } = await withRepositories();
    const release = await ok("POST", `/api/projects/${project.id}/releases`, ada, { name: "v0.3.0" });
    expect((await cut(project.id, release.id, ada)).status).toBe(200);
    const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
    const { secret } = await ok("POST", `/api/agents/${created.id}/tokens`, ada, { name: "laptop", access: "write" });
    const client = await connect(secret);

    expect((await tool(client, "list_releases", { project: "CRONK" })).json[0].state).toBe("cut");
    for (const [name, args] of [
      ["rename_release", { project: "CRONK", release: "v0.3.0", name: "v0.3.1" }],
      ["delete_release", { project: "CRONK", release: "v0.3.0" }],
    ] as const) {
      const refused = await tool(client, name, args);
      expect(refused, name).toEqual({ isError: true, json: expect.objectContaining({ code: "release_not_planned" }) });
    }

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).filter((n) => /cut|publish/.test(n) || /^release/.test(n))).toEqual([]);
  });
});
