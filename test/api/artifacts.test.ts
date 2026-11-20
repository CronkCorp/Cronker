import { afterEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

let cronk: StartedCronk;
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

/** Ada's Workspace with a Project CRONK, and a full token of her Agent `claude-max`. */
async function workspaceWithProject(options: Parameters<typeof startCronk>[0] = {}) {
  cronk = await startCronk(options);
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "full" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, user, ada, project, agent, asAgent };
}

const base64 = (text: string) => Buffer.from(text).toString("base64");

/** A file of an Artifact as a save sends it: its relative path and its bytes as base64. */
const file = (path: string, text: string, mediaType?: string) => ({
  path,
  contentBase64: base64(text),
  ...(mediaType ? { mediaType } : {}),
});

/** Fetches a served file of an Artifact as a browser would open it: by its address alone, with no sign-in. */
async function open(url: string) {
  const response = await fetch(new URL(url, cronk.url));
  return { status: response.status, headers: response.headers, text: await response.text() };
}

const page = `<!doctype html><title>Board</title><link rel="stylesheet" href="styles/board.css"><script src="app.js"></script>`;

describe("Artifacts", () => {
  test("a User creates an Artifact in a Project and reads it at Version 1, with its files, saved by them", async () => {
    const { ada, user, project, workspace } = await workspaceWithProject();

    const created = await call("POST", `/api/projects/${project.id}/artifacts`, ada, {
      title: "Board prototype",
      description: "A board with drag and drop.",
      files: [file("index.html", page), file("app.js", "document.title = 'Ran';"), file("styles/board.css", "body{}")],
    });

    expect(created.status).toBe(201);
    const read = await ok("GET", `/api/artifacts/${created.json.id}`, ada);
    expect(read).toEqual({
      id: created.json.id,
      workspaceId: workspace.id,
      projectId: project.id,
      title: "Board prototype",
      description: "A board with drag and drop.",
      page: "index.html",
      url: expect.stringMatching(/^\/sandbox\/[A-Za-z0-9_-]{20,}\/index\.html$/),
      version: {
        number: 1,
        actor: { kind: "user", id: user.id, name: user.email },
        savedAt: expect.any(String),
      },
      files: [
        { path: "app.js", mediaType: "text/javascript", size: 23 },
        { path: "index.html", mediaType: "text/html", size: Buffer.byteLength(page) },
        { path: "styles/board.css", mediaType: "text/css", size: 6 },
      ],
    });
    expect(created.json).toEqual(read);
  });

  test("every file of a Version is served sandboxed from Cronk's own address, opened directly, its relative paths resolving within the Version", async () => {
    const { ada, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page), file("app.js", "document.title = 'Ran';"), file("styles/board.css", "body{}")],
    });

    const pageUrl = new URL(artifact.url, cronk.url);
    expect(pageUrl.origin).toBe(new URL(cronk.url).origin);
    const served = [
      { path: "", type: "text/html; charset=utf-8", text: page },
      { path: "app.js", type: "text/javascript; charset=utf-8", text: "document.title = 'Ran';" },
      { path: "styles/board.css", type: "text/css; charset=utf-8", text: "body{}" },
    ];
    for (const { path, type, text } of served) {
      // Each resolves against the page's own address, as the browser resolves the page's references.
      const opened = await open(path ? new URL(path, pageUrl).href : pageUrl.href);
      expect(opened.status, path).toBe(200);
      expect(opened.text).toBe(text);
      expect(opened.headers.get("content-type")).toBe(type);
      expect(opened.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
      expect(opened.headers.get("x-content-type-options")).toBe("nosniff");
    }

    // A path the Version doesn't hold is not there, and stays sandboxed.
    const missing = await open(new URL("missing.js", pageUrl).href);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    // Nor does a path climb out of the Version.
    expect((await open(new URL("../other/index.html", pageUrl).href)).status).toBe(404);
    // Asked only for its headers, a file is sandboxed all the same.
    const head = await fetch(pageUrl, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    // The Version's own address, with or without its last slash, leads to its page, sandboxed on the way.
    const key = pageUrl.pathname.split("/")[2];
    for (const path of [`/sandbox/${key}`, `/sandbox/${key}/`]) {
      const response = await fetch(new URL(path, cronk.url), { redirect: "manual" });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(pageUrl.pathname);
      expect(response.headers.get("content-security-policy"), path).toBe("sandbox allow-scripts");
    }
    for (const path of ["/sandbox", "/sandbox/", "/sandbox/unknown"]) {
      const response = await open(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-security-policy"), path).toBe("sandbox allow-scripts");
    }
  });

  test("a save makes the next Version holding the whole set of files, adding, replacing and removing some, while the earlier Version stays served as it was", async () => {
    const { ada, asAgent, agent, project } = await workspaceWithProject();
    const first = await ok("POST", `/api/projects/${project.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page), file("app.js", "document.title = 'Ran';"), file("styles/board.css", "body{}")],
    });

    const saved = await call("PATCH", `/api/artifacts/${first.id}`, asAgent, {
      baseVersion: 1,
      description: "Now with a legend.",
      files: [file("app.js", "document.title = 'Ran again';"), file("data/cards.json", '{"cards":[]}')],
      remove: ["styles/board.css"],
    });

    expect(saved.status).toBe(200);
    expect(saved.json).toEqual({
      ...first,
      description: "Now with a legend.",
      url: expect.stringMatching(/^\/sandbox\/[A-Za-z0-9_-]{20,}\/index\.html$/),
      version: { number: 2, actor: { kind: "agent", id: agent.id, name: "claude-max" }, savedAt: expect.any(String) },
      files: [
        { path: "app.js", mediaType: "text/javascript", size: 29 },
        { path: "data/cards.json", mediaType: "application/json", size: 12 },
        { path: "index.html", mediaType: "text/html", size: Buffer.byteLength(page) },
      ],
    });
    expect(saved.json.url).not.toBe(first.url);
    expect(await ok("GET", `/api/artifacts/${first.id}`, ada)).toEqual(saved.json);

    const now = new URL(saved.json.url, cronk.url);
    expect((await open(new URL("app.js", now).href)).text).toBe("document.title = 'Ran again';");
    expect((await open(new URL("data/cards.json", now).href)).text).toBe('{"cards":[]}');
    expect((await open(new URL("index.html", now).href)).text).toBe(page);
    expect((await open(new URL("styles/board.css", now).href)).status).toBe(404);

    // Version 1 is still served as it was saved.
    const then = new URL(first.url, cronk.url);
    expect((await open(new URL("app.js", then).href)).text).toBe("document.title = 'Ran';");
    expect((await open(new URL("styles/board.css", then).href)).text).toBe("body{}");
  });

  test("a save based on an outdated Version is refused with the current Version, and changes nothing", async () => {
    const { ada, asAgent, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page)],
    });
    const second = await ok("PATCH", `/api/artifacts/${artifact.id}`, ada, { baseVersion: 1, title: "Board, take two" });

    const refused = await call("PATCH", `/api/artifacts/${artifact.id}`, asAgent, {
      baseVersion: 1,
      files: [file("index.html", "<p>Mine</p>")],
    });

    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({
      code: "outdated_version",
      message: "The Artifact is at Version 2, but this save is based on Version 1.",
      rule: expect.any(String),
      advice: expect.any(String),
      current: second.version,
    });
    expect(await ok("GET", `/api/artifacts/${artifact.id}`, ada)).toEqual(second);
    // A save names the Version it's based on.
    const unnamed = await call("PATCH", `/api/artifacts/${artifact.id}`, asAgent, { title: "Board, take three" });
    expect(unnamed.status).toBe(400);
    expect(unnamed.json.error.code).toBe("base_version_needed");
  });

  test("a Version whose files are over the Attachments size limit is refused, on create and on save, naming the limit", async () => {
    const { ada, asAgent, workspace } = await workspaceWithProject({ attachmentLimitBytes: 1024 });
    const tooLarge = (path: string) => file(path, "x".repeat(600));

    const create = await call("POST", `/api/workspaces/${workspace.id}/artifacts`, asAgent, {
      title: "Board prototype",
      files: [file("index.html", "x".repeat(1025))],
    });
    expect(create.status).toBe(413);
    expect(create.json.error).toMatchObject({
      code: "artifact_too_large",
      message: "An Artifact's files may be at most 1 KB in all.",
      rule: expect.any(String),
      advice: expect.any(String),
    });

    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [tooLarge("index.html")],
    });
    // The files the save keeps count with those it adds.
    const save = await call("PATCH", `/api/artifacts/${artifact.id}`, asAgent, { baseVersion: 1, files: [tooLarge("app.js")] });
    expect(save.status).toBe(413);
    expect(save.json.error.code).toBe("artifact_too_large");
    expect(await ok("GET", `/api/artifacts/${artifact.id}`, ada)).toEqual(artifact);
    // Files far over the limit are refused alike, before Cronk reads them all.
    const huge = await call("POST", `/api/workspaces/${workspace.id}/artifacts`, asAgent, {
      title: "Board prototype",
      files: [file("index.html", "x".repeat(2 * 1024 * 1024))],
    });
    expect(huge.status).toBe(413);
    expect(huge.json.error).toMatchObject({ code: "artifact_too_large", rule: expect.any(String), advice: expect.any(String) });
    // Replacing a file counts only what replaces it.
    expect((await call("PATCH", `/api/artifacts/${artifact.id}`, asAgent, { baseVersion: 1, files: [tooLarge("index.html")] })).status).toBe(200);
  });

  test("a file set is refused when a path leaves the Version, repeats, or the page isn't among the files", async () => {
    const { ada, workspace } = await workspaceWithProject();
    const create = (body: Record<string, unknown>) =>
      call("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, { title: "Board prototype", ...body });

    for (const path of ["../index.html", "/index.html", "a//b.js", "./app.js", "scripts/../app.js", "a\\b.js"]) {
      const refused = await create({ files: [file("index.html", page), file(path, "x")] });
      expect(refused.status, path).toBe(400);
      expect(refused.json.error.code, path).toBe("invalid_path");
    }
    const repeated = await create({ files: [file("index.html", page), file("index.html", page)] });
    expect(repeated.json.error.code).toBe("repeated_path");
    const noPage = await create({ files: [file("app.js", "x")] });
    expect(noPage.status).toBe(400);
    expect(noPage.json.error).toMatchObject({ code: "page_missing", message: "The Artifact's page, index.html, isn't among its files." });
    expect((await create({ page: "app.html", files: [file("app.html", page)] })).status).toBe(201);
    const notBase64 = await create({ files: [{ path: "index.html", contentBase64: "<p>Hi</p>" }] });
    expect(notBase64.json.error.code).toBe("invalid_base64");

    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page)],
    });
    const removingPage = await call("PATCH", `/api/artifacts/${artifact.id}`, ada, { baseVersion: 1, remove: ["index.html"] });
    expect(removingPage.json.error.code).toBe("page_missing");
  });

  test("a Project's Artifacts and the Workspace's are listed apart, last changed first, without their files", async () => {
    const { ada, asAgent, project, workspace } = await workspaceWithProject();
    const create = (path: string, title: string, as: As) =>
      ok("POST", path, as, { title, description: `${title}, described.`, files: [file("index.html", page)] });
    const board = await create(`/api/projects/${project.id}/artifacts`, "Board", asAgent);
    cronk.clock.advance(60_000);
    const inbox = await create(`/api/projects/${project.id}/artifacts`, "Inbox", ada);
    cronk.clock.advance(60_000);
    const report = await create(`/api/workspaces/${workspace.id}/artifacts`, "Weekly report", ada);
    cronk.clock.advance(60_000);
    const savedBoard = await ok("PATCH", `/api/artifacts/${board.id}`, asAgent, { baseVersion: 1, title: "Board, take two" });

    const summary = ({ files: _files, ...artifact }: { files: unknown }) => artifact;
    expect(await ok("GET", `/api/projects/${project.id}/artifacts`, asAgent)).toEqual([summary(savedBoard), summary(inbox)]);
    expect(await ok("GET", `/api/workspaces/${workspace.id}/artifacts`, ada)).toEqual([summary(report)]);
  });

  test("an Artifact outside the caller's Workspace answers as not found, and a read-only token can't create or save one", async () => {
    const { ada, agent, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page)],
    });
    const other = await ok("POST", "/api/workspaces", ada, { name: "Elsewhere" });
    const stranger = await ok("POST", `/api/workspaces/${other.id}/agents`, ada, { name: "stranger" });
    const { secret } = await ok("POST", `/api/agents/${stranger.id}/tokens`, ada, { name: "laptop", access: "full" });
    const asStranger = { headers: { authorization: `Bearer ${secret}` } };

    expect((await call("GET", `/api/artifacts/${artifact.id}`, asStranger)).status).toBe(404);
    expect((await call("PATCH", `/api/artifacts/${artifact.id}`, asStranger, { baseVersion: 1, title: "Mine" })).status).toBe(404);
    expect((await call("GET", `/api/workspaces/${workspace.id}/artifacts`, asStranger)).status).toBe(404);

    const readOnly = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "reader", access: "read" });
    const asReader = { headers: { authorization: `Bearer ${readOnly.secret}` } };
    expect((await call("GET", `/api/artifacts/${artifact.id}`, asReader)).status).toBe(200);
    const refused = await call("PATCH", `/api/artifacts/${artifact.id}`, asReader, { baseVersion: 1, title: "Mine" });
    expect(refused.json.error.code).toBe("read_only_token");
    const create = await call("POST", `/api/workspaces/${workspace.id}/artifacts`, asReader, {
      title: "Mine",
      files: [file("index.html", page)],
    });
    expect(create.json.error.code).toBe("read_only_token");
  });

  test("an Actor reads a file of an Artifact's current Version, its bytes as base64", async () => {
    const { ada, asAgent, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page), file("data/cards.json", '{"cards":[]}')],
    });

    expect(await ok("GET", `/api/artifacts/${artifact.id}/file?path=data%2Fcards.json`, asAgent)).toEqual({
      path: "data/cards.json",
      mediaType: "application/json",
      size: 12,
      contentBase64: base64('{"cards":[]}'),
    });
    const missing = await call("GET", `/api/artifacts/${artifact.id}/file?path=nothing.js`, asAgent);
    expect(missing.status).toBe(404);
    expect(missing.json.error.message).toBe("Board prototype has no file nothing.js.");
  });

  test("an Agent's delete is refused and changes nothing; a User's removes the Artifact, its Versions and their files", async () => {
    const { ada, asAgent, project, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/projects/${project.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page), file("app.js", "1")],
    });
    const first = artifact.url;
    const saved = await ok("PATCH", `/api/artifacts/${artifact.id}`, ada, { baseVersion: 1, files: [file("app.js", "2")] });
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Try drag and drop" });
    await ok("POST", `/api/tickets/${ticket.id}/artifacts`, ada, { artifactId: artifact.id });
    const stream = await openStream(cronk, ada.cookie!, workspace.id);

    const byAgent = await call("DELETE", `/api/artifacts/${artifact.id}`, asAgent);

    expect(byAgent.status).toBe(403);
    expect(byAgent.json.error).toEqual(
      expect.objectContaining({ code: "agent_not_allowed", rule: expect.any(String), advice: expect.any(String) }),
    );
    expect((await ok("GET", `/api/artifacts/${artifact.id}`, ada)).version.number).toBe(2);
    expect((await open(saved.url)).status).toBe(200);
    expect(await cronk.attachmentFiles()).toHaveLength(3);
    await stream.expectQuiet();

    const byUser = await call("DELETE", `/api/artifacts/${artifact.id}`, ada);

    expect(byUser.status).toBe(204);
    expect((await call("GET", `/api/artifacts/${artifact.id}`, ada)).status).toBe(404);
    expect(await ok("GET", `/api/projects/${project.id}/artifacts`, ada)).toEqual([]);
    expect((await open(first)).status).toBe(404);
    expect((await open(saved.url)).status).toBe(404);
    expect(await cronk.attachmentFiles()).toEqual([]);
    // It drops out of its links, and the Ticket linking it shows the change.
    expect(await ok("GET", `/api/tickets/${ticket.id}/artifacts`, ada)).toEqual([]);
    const events = [await stream.next(), await stream.next()];
    expect(events).toEqual(
      expect.arrayContaining([
        { type: "artifact.changed", data: { projectId: project.id, artifactId: artifact.id } },
        { type: "ticket.changed", data: { projectId: project.id, ticketId: ticket.id } },
      ]),
    );
    expect((await call("DELETE", `/api/artifacts/${artifact.id}`, ada)).status).toBe(404);
    stream.close();
  });
});
