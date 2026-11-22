import { afterEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { hours } from "../harness/clock.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

const cdns = "https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com";
/** What every sandbox response carries: the sandbox, and a page loading only its own files, inline code and the CDNs. */
const sandboxHeader =
  "sandbox allow-scripts; default-src 'none'; " +
  `script-src 'self' 'unsafe-inline' ${cdns}; style-src 'self' 'unsafe-inline' ${cdns}; ` +
  `img-src 'self' data: blob: ${cdns}; media-src 'self' data: blob: ${cdns}; font-src 'self' data: blob: ${cdns}; ` +
  "connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'";

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
      slug: `board-prototype-${created.json.id.slice(0, 8)}`,
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
      expect(opened.headers.get("content-security-policy")).toBe(sandboxHeader);
      expect(opened.headers.get("x-content-type-options")).toBe("nosniff");
      expect(opened.headers.get("access-control-allow-origin")).toBe("*");
    }

    // A path the Version doesn't hold is not there, and stays sandboxed.
    const missing = await open(new URL("missing.js", pageUrl).href);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-security-policy")).toBe(sandboxHeader);
    // Nor does a path climb out of the Version.
    expect((await open(new URL("../other/index.html", pageUrl).href)).status).toBe(404);
    // Asked only for its headers, a file is sandboxed all the same.
    const head = await fetch(pageUrl, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-security-policy")).toBe(sandboxHeader);
    // The Version's own address, with or without its last slash, leads to its page, sandboxed on the way.
    const key = pageUrl.pathname.split("/")[2];
    for (const path of [`/sandbox/${key}`, `/sandbox/${key}/`]) {
      const response = await fetch(new URL(path, cronk.url), { redirect: "manual" });
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(pageUrl.pathname);
      expect(response.headers.get("content-security-policy"), path).toBe(sandboxHeader);
    }
    for (const path of ["/sandbox", "/sandbox/", "/sandbox/unknown"]) {
      const response = await open(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-security-policy"), path).toBe(sandboxHeader);
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

  test("refused, changing nothing: another Workspace's Agent reading, listing, comparing or saving, and a read-only token creating or saving", async () => {
    const { ada, agent, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page)],
    });
    const other = await ok("POST", "/api/workspaces", ada, { name: "Elsewhere" });
    const stranger = await ok("POST", `/api/workspaces/${other.id}/agents`, ada, { name: "stranger" });
    const { secret } = await ok("POST", `/api/agents/${stranger.id}/tokens`, ada, { name: "laptop", access: "full" });
    const asStranger = { headers: { authorization: `Bearer ${secret}` } };
    const readOnly = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "reader", access: "read" });
    const asReader = { headers: { authorization: `Bearer ${readOnly.secret}` } };
    // A read-only token reads Artifacts.
    expect((await call("GET", `/api/artifacts/${artifact.id}`, asReader)).status).toBe(200);

    const refusals: [string, As, string, string, unknown, number, string?][] = [
      // An Artifact outside the caller's Workspace answers as not found.
      ["a stranger", asStranger, "GET", `/api/artifacts/${artifact.id}`, undefined, 404],
      ["a stranger", asStranger, "PATCH", `/api/artifacts/${artifact.id}`, { baseVersion: 1, title: "Mine" }, 404],
      ["a stranger", asStranger, "GET", `/api/workspaces/${workspace.id}/artifacts`, undefined, 404],
      ["a stranger", asStranger, "GET", `/api/artifacts/${artifact.id}/versions`, undefined, 404],
      ["a stranger", asStranger, "GET", `/api/artifacts/${artifact.id}/versions/compare?from=1&to=1`, undefined, 404],
      ["a stranger", asStranger, "GET", `/api/artifacts/${artifact.id}/versions/1`, undefined, 404],
      ["a stranger", asStranger, "DELETE", `/api/artifacts/${artifact.id}/versions/1`, undefined, 404],
      ["a read-only token", asReader, "DELETE", `/api/artifacts/${artifact.id}/versions/1`, undefined, 403, "read_only_token"],
      ["a read-only token", asReader, "PATCH", `/api/artifacts/${artifact.id}`, { baseVersion: 1, title: "Mine" }, 403, "read_only_token"],
      [
        "a read-only token",
        asReader,
        "POST",
        `/api/workspaces/${workspace.id}/artifacts`,
        { title: "Mine", files: [file("index.html", page)] },
        403,
        "read_only_token",
      ],
    ];
    for (const [who, as, method, path, body, status, code] of refusals) {
      const refused = await call(method, path, as, body);
      expect(refused.status, `${who}: ${method} ${path}`).toBe(status);
      if (code) expect(refused.json.error.code, `${who}: ${method} ${path}`).toBe(code);
    }

    const kept = await ok("GET", `/api/artifacts/${artifact.id}`, ada);
    expect(kept).toEqual(expect.objectContaining({ title: "Board prototype", version: expect.objectContaining({ number: 1 }) }));
    expect((await ok("GET", `/api/workspaces/${workspace.id}/artifacts`, ada)).map((a: { id: string }) => a.id)).toEqual([artifact.id]);
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

  test("an Artifact's Versions are listed oldest first, each with the Actor who saved it and when", async () => {
    const { ada, user, agent, asAgent, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page)],
    });
    cronk.clock.advance(hours(2));
    await ok("PATCH", `/api/artifacts/${artifact.id}`, asAgent, { baseVersion: 1, files: [file("app.js", "run();")] });

    expect(await ok("GET", `/api/artifacts/${artifact.id}/versions`, asAgent)).toEqual([
      { number: 1, actor: { kind: "user", id: user.id, name: user.email }, savedAt: "2026-01-01T09:00:00.000Z" },
      { number: 2, actor: { kind: "agent", id: agent.id, name: "claude-max" }, savedAt: "2026-01-01T11:00:00.000Z" },
    ]);
    expect((await call("GET", "/api/artifacts/00000000-0000-4000-8000-000000000000/versions", ada)).status).toBe(404);
  });

  test("comparing two Versions gives each changed file's text compared line by line, leaving out files that didn't change", async () => {
    const { ada, asAgent, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page), file("app.js", "start();\nrender();\nstop();")],
    });
    // Saved again with the same bytes, a file still hasn't changed.
    await ok("PATCH", `/api/artifacts/${artifact.id}`, asAgent, {
      baseVersion: 1,
      files: [file("index.html", page), file("app.js", "start();\nrender(board);\nstop();")],
    });

    const comparison = await ok("GET", `/api/artifacts/${artifact.id}/versions/compare?from=1&to=2`, asAgent);
    expect(comparison.from.number).toBe(1);
    expect(comparison.to).toMatchObject({ number: 2, actor: { kind: "agent", name: "claude-max" } });
    expect(comparison.files).toEqual([
      {
        path: "app.js",
        change: "changed",
        text: true,
        lines: [
          { change: "same", text: "start();" },
          { change: "removed", text: "render();" },
          { change: "added", text: "render(board);" },
          { change: "same", text: "stop();" },
        ],
      },
    ]);
  });

  test("comparing two Versions shows files added and removed as such, and a file that isn't text without its lines", async () => {
    const { ada, workspace } = await workspaceWithProject();
    const png = (byte: number) => ({ path: "logo.png", contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, byte]).toString("base64") });
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      // A file ending in a newline, as most do, has no empty last line.
      files: [file("index.html", page), file("app.js", "start();\nstop();\n"), png(1)],
    });
    await ok("PATCH", `/api/artifacts/${artifact.id}`, ada, {
      baseVersion: 1,
      files: [file("data/cards.json", '[\n  "Write the spec"\n]'), png(2)],
      remove: ["app.js"],
    });

    const comparison = await ok("GET", `/api/artifacts/${artifact.id}/versions/compare?from=1&to=2`, ada);
    expect(comparison.files).toEqual([
      {
        path: "app.js",
        change: "removed",
        text: true,
        lines: [
          { change: "removed", text: "start();" },
          { change: "removed", text: "stop();" },
        ],
      },
      {
        path: "data/cards.json",
        change: "added",
        text: true,
        lines: [
          { change: "added", text: "[" },
          { change: "added", text: '  "Write the spec"' },
          { change: "added", text: "]" },
        ],
      },
      { path: "logo.png", change: "changed", text: false, lines: [] },
    ]);
    // Compared the other way, the same files read the other way round.
    const back = await ok("GET", `/api/artifacts/${artifact.id}/versions/compare?from=2&to=1`, ada);
    expect(back.files.map((f: { path: string; change: string }) => [f.path, f.change])).toEqual([
      ["app.js", "added"],
      ["data/cards.json", "removed"],
      ["logo.png", "changed"],
    ]);
    const missing = await call("GET", `/api/artifacts/${artifact.id}/versions/compare?from=1&to=3`, ada);
    expect(missing.status).toBe(404);
    expect(missing.json.error.message).toBe("Board prototype has no Version 3.");
  });

  test("comparing two Versions shows a file whose line endings alone changed with every line the same, and an empty file added with no lines", async () => {
    const { ada, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page), file("app.js", "start();\r\nstop();\r\n")],
    });
    await ok("PATCH", `/api/artifacts/${artifact.id}`, ada, {
      baseVersion: 1,
      files: [file("app.js", "start();\nstop();"), file("empty.txt", "")],
    });

    expect((await ok("GET", `/api/artifacts/${artifact.id}/versions/compare?from=1&to=2`, ada)).files).toEqual([
      {
        path: "app.js",
        change: "changed",
        text: true,
        lines: [
          { change: "same", text: "start();" },
          { change: "same", text: "stop();" },
        ],
      },
      { path: "empty.txt", change: "added", text: true, lines: [] },
    ]);
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

describe("Deleting one Artifact Version", () => {
  test("a User deletes a Version that leaked something: the others stay, and its bytes go unless another Version shares them", async () => {
    const { ada, user, project, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/projects/${project.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page), file("app.js", "const token = 'leaked';")],
    });
    const saved = await ok("PATCH", `/api/artifacts/${artifact.id}`, ada, { baseVersion: 1, files: [file("app.js", "const token = env();")] });
    // Version 2 keeps Version 1's page, so the two share its bytes.
    expect(await cronk.attachmentFiles()).toHaveLength(3);
    const stream = await openStream(cronk, ada.cookie!, workspace.id);

    expect((await call("DELETE", `/api/artifacts/${artifact.id}/versions/1`, ada)).status).toBe(204);

    expect(await stream.next()).toEqual({ type: "artifact.changed", data: { projectId: project.id, artifactId: artifact.id } });
    stream.close();
    // The shared page is kept for Version 2; the leaked script is freed.
    expect(await cronk.attachmentFiles()).toHaveLength(2);
    expect(await ok("GET", `/api/artifacts/${artifact.id}`, ada)).toEqual(saved);
    expect((await ok("GET", `/api/artifacts/${artifact.id}/versions`, ada)).map((v: { number: number }) => v.number)).toEqual([2]);
    expect((await open(artifact.url)).status).toBe(404);
    expect((await open(saved.url)).status).toBe(200);
    expect((await open(saved.url.replace("index.html", "app.js"))).text).toBe("const token = env();");

    const deleted = await call("GET", `/api/artifacts/${artifact.id}/versions/1`, ada);
    expect(deleted.status).toBe(410);
    expect(deleted.json.error).toEqual(
      expect.objectContaining({ code: "version_deleted", message: "Version 1 of Board prototype was deleted." }),
    );
    expect(await ok("GET", `/api/artifacts/${artifact.id}/versions/2`, ada)).toEqual({
      number: 2,
      actor: { kind: "user", id: user.id, name: user.email },
      savedAt: saved.version.savedAt,
      title: "Board prototype",
      description: "",
      page: "index.html",
      url: saved.url,
      files: saved.files,
    });
    const compared = await call("GET", `/api/artifacts/${artifact.id}/versions/compare?from=1&to=2`, ada);
    expect(compared.status).toBe(410);
    expect(compared.json.error.code).toBe("version_deleted");
    const again = await call("DELETE", `/api/artifacts/${artifact.id}/versions/1`, ada);
    expect([again.status, again.json.error.code]).toEqual([410, "version_deleted"]);
    // A number the Artifact never had is not found.
    const never = await call("GET", `/api/artifacts/${artifact.id}/versions/9`, ada);
    expect([never.status, never.json.error.code]).toEqual([404, "not_found"]);
    expect((await call("DELETE", `/api/artifacts/${artifact.id}/versions/9`, ada)).status).toBe(404);
  });

  test("deleting the current Version makes the newest remaining one current; its number is never reused, and a save based on it is outdated", async () => {
    const { ada, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page), file("app.js", "1")],
    });
    const second = await ok("PATCH", `/api/artifacts/${artifact.id}`, ada, { baseVersion: 1, files: [file("app.js", "2")] });
    const third = await ok("PATCH", `/api/artifacts/${artifact.id}`, ada, {
      baseVersion: 2,
      title: "Board, take three",
      files: [file("app.js", "3")],
    });

    expect((await call("DELETE", `/api/artifacts/${artifact.id}/versions/3`, ada)).status).toBe(204);

    expect(await ok("GET", `/api/artifacts/${artifact.id}`, ada)).toEqual(second);
    expect((await open(third.url)).status).toBe(404);
    const outdated = await call("PATCH", `/api/artifacts/${artifact.id}`, ada, { baseVersion: 3, title: "Mine" });
    expect(outdated.status).toBe(409);
    expect(outdated.json.error).toEqual(expect.objectContaining({ code: "outdated_version", current: second.version }));

    const fourth = await ok("PATCH", `/api/artifacts/${artifact.id}`, ada, { baseVersion: 2, files: [file("app.js", "4")] });

    expect(fourth.version.number).toBe(4);
    expect((await ok("GET", `/api/artifacts/${artifact.id}/versions`, ada)).map((v: { number: number }) => v.number)).toEqual([1, 2, 4]);
    expect((await call("GET", `/api/artifacts/${artifact.id}/versions/3`, ada)).json.error.code).toBe("version_deleted");
    // Comparing skips the deleted Version: the remaining ones compare as before.
    const comparison = await ok("GET", `/api/artifacts/${artifact.id}/versions/compare?from=2&to=4`, ada);
    expect(comparison.files.map((f: { path: string; change: string }) => [f.path, f.change])).toEqual([["app.js", "changed"]]);
    // Deleting a Version under the current one leaves the current one as it is.
    expect((await call("DELETE", `/api/artifacts/${artifact.id}/versions/1`, ada)).status).toBe(204);
    expect(await ok("GET", `/api/artifacts/${artifact.id}`, ada)).toEqual(fourth);
  });

  test("refused, changing nothing: an Agent deleting a Version, and a User deleting an Artifact's only Version", async () => {
    const { ada, asAgent, workspace } = await workspaceWithProject();
    const artifact = await ok("POST", `/api/workspaces/${workspace.id}/artifacts`, ada, {
      title: "Board prototype",
      files: [file("index.html", page)],
    });
    const stream = await openStream(cronk, ada.cookie!, workspace.id);

    const only = await call("DELETE", `/api/artifacts/${artifact.id}/versions/1`, ada);

    expect(only.status).toBe(409);
    expect(only.json.error).toEqual(
      expect.objectContaining({ code: "only_version", rule: expect.any(String), advice: expect.stringContaining("Delete the Artifact") }),
    );
    const saved = await ok("PATCH", `/api/artifacts/${artifact.id}`, asAgent, { baseVersion: 1, files: [file("app.js", "2")] });
    await stream.next();

    const byAgent = await call("DELETE", `/api/artifacts/${artifact.id}/versions/1`, asAgent);

    expect(byAgent.status).toBe(403);
    expect(byAgent.json.error).toEqual(
      expect.objectContaining({ code: "agent_not_allowed", rule: expect.any(String), advice: expect.any(String) }),
    );
    await stream.expectQuiet();
    stream.close();
    expect(await ok("GET", `/api/artifacts/${artifact.id}`, ada)).toEqual(saved);
    expect((await ok("GET", `/api/artifacts/${artifact.id}/versions`, ada)).map((v: { number: number }) => v.number)).toEqual([1, 2]);
    expect((await open(artifact.url)).status).toBe(200);
    expect(await cronk.attachmentFiles()).toHaveLength(2);
  });
});
