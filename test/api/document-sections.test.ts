import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

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

const guide = [
  "# Guide",
  "",
  "Welcome.",
  "",
  "## Install",
  "",
  "Get it.",
  "",
  "### Linux",
  "",
  "```sh",
  "# not a heading",
  "apt install cronk",
  "```",
  "",
  "### macOS",
  "",
  "brew install cronk",
  "",
  "## Uninstall",
  "",
  "### Linux",
  "",
  "apt remove cronk",
  "",
  "## Upgrade `cronk`",
  "",
  "Pull and restart.",
  "",
].join("\n");

/** Ada's Workspace with a Project CRONK holding the guide above, and a full and a read-only token of her Agent. */
async function workspaceWithGuide() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const full = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "write" });
  const read = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "reader", access: "read" });
  const asAgent = { headers: { authorization: `Bearer ${full.secret}` } };
  const asReader = { headers: { authorization: `Bearer ${read.secret}` } };
  const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Guide", body: guide });
  return { workspace, user, ada, project, agent, asAgent, asReader, document };
}

const sectionPath = (documentId: string, name: string) =>
  `/api/documents/${documentId}/sections?section=${encodeURIComponent(name)}`;

describe("Document sections", () => {
  test("a Section is its heading with everything up to the next heading of the same or a higher level", async () => {
    const { ada, user, document } = await workspaceWithGuide();

    const install = await ok("GET", sectionPath(document.id, "Install"), ada);

    expect(install).toEqual({
      documentId: document.id,
      path: "Guide/Install",
      level: 2,
      body: [
        "## Install",
        "",
        "Get it.",
        "",
        "### Linux",
        "",
        "```sh",
        "# not a heading",
        "apt install cronk",
        "```",
        "",
        "### macOS",
        "",
        "brew install cronk",
      ].join("\n"),
      version: {
        number: 1,
        title: "Guide",
        actor: { kind: "user", id: user.id, name: "ada@example.com" },
        savedAt: "2026-01-01T09:00:00.000Z",
      },
    });
    const top = await ok("GET", sectionPath(document.id, "Guide"), ada);
    expect(top.body).toBe(guide.trimEnd());
    const last = await ok("GET", sectionPath(document.id, "Upgrade cronk"), ada);
    expect(last).toEqual(expect.objectContaining({ path: "Guide/Upgrade cronk", body: "## Upgrade `cronk`\n\nPull and restart." }));
  });

  test("a path joining headings with `/` names a Section under another, from its end or its top", async () => {
    const { asAgent, document } = await workspaceWithGuide();

    for (const name of ["Uninstall/Linux", " Uninstall / Linux ", "Guide/Uninstall/Linux"]) {
      const section = await ok("GET", sectionPath(document.id, name), asAgent);
      expect(section, name).toEqual(
        expect.objectContaining({ path: "Guide/Uninstall/Linux", level: 3, body: "### Linux\n\napt remove cronk" }),
      );
    }
    const macos = await ok("GET", sectionPath(document.id, "macOS"), asAgent);
    expect(macos.body).toBe("### macOS\n\nbrew install cronk");
  });

  test("a heading matching several Sections is refused, naming them as paths", async () => {
    const { asAgent, document } = await workspaceWithGuide();

    const refused = await call("GET", sectionPath(document.id, "Linux"), asAgent);

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(
      expect.objectContaining({
        code: "section_ambiguous",
        candidates: ["Guide/Install/Linux", "Guide/Uninstall/Linux"],
        rule: expect.any(String),
        advice: expect.any(String),
      }),
    );
    expect(refused.json.error.message).toContain("Guide/Install/Linux, Guide/Uninstall/Linux");
  });

  test("a heading matching none is refused, listing the Document's headings; a heading in a code block isn't one", async () => {
    const { asAgent, document } = await workspaceWithGuide();

    for (const name of ["Windows", "not a heading", "install", "Install/macOS/Extra", "Uninstall/macOS"]) {
      const refused = await call("GET", sectionPath(document.id, name), asAgent);
      expect(refused.status, name).toBe(404);
      expect(refused.json.error).toEqual(
        expect.objectContaining({
          code: "section_not_found",
          headings: [
            "Guide",
            "Guide/Install",
            "Guide/Install/Linux",
            "Guide/Install/macOS",
            "Guide/Uninstall",
            "Guide/Uninstall/Linux",
            "Guide/Upgrade cronk",
          ],
          rule: expect.any(String),
        }),
      );
    }
  });

  test("replacing a Section makes the next Version, changing only that Section, comparable with the others", async () => {
    const { ada, agent, asAgent, document } = await workspaceWithGuide();
    cronk.clock.advance(60_000);

    const replaced = await ok("PUT", `/api/documents/${document.id}/sections`, asAgent, {
      section: "Uninstall/Linux",
      baseVersion: 1,
      body: "### Linux and WSL\n\napt purge cronk\n",
    });

    expect(replaced).toEqual({
      documentId: document.id,
      path: "Guide/Uninstall/Linux and WSL",
      level: 3,
      body: "### Linux and WSL\n\napt purge cronk",
      version: {
        number: 2,
        title: "Guide",
        actor: { kind: "agent", id: agent.id, name: "claude-max" },
        savedAt: "2026-01-01T09:01:00.000Z",
      },
      avoidedWords: [],
    });
    const read = await ok("GET", `/api/documents/${document.id}`, ada);
    expect(read.body).toBe(guide.replace("### Linux\n\napt remove cronk", "### Linux and WSL\n\napt purge cronk"));
    expect(read.version.number).toBe(2);
    const versions = await ok("GET", `/api/documents/${document.id}/versions`, ada);
    expect(versions.map((v: { number: number }) => v.number)).toEqual([1, 2]);
    const compared = await ok("GET", `/api/documents/${document.id}/versions/compare?from=1&to=2`, ada);
    expect(compared.lines.filter((line: { change: string }) => line.change !== "same")).toEqual([
      { change: "removed", text: "### Linux" },
      { change: "added", text: "### Linux and WSL" },
      { change: "removed", text: "apt remove cronk" },
      { change: "added", text: "apt purge cronk" },
    ]);
  });

  test("a replace keeps its subsections only as the new body gives them, and the Document's last Section keeps its end", async () => {
    const { ada, asAgent, document } = await workspaceWithGuide();

    await ok("PUT", `/api/documents/${document.id}/sections`, asAgent, {
      section: "Install",
      baseVersion: 1,
      body: "## Install\n\nUse the image.\n\n### Docker\n\ndocker run cronk",
    });
    await ok("PUT", `/api/documents/${document.id}/sections`, asAgent, {
      section: "Upgrade cronk",
      baseVersion: 2,
      body: "## Upgrade\n\nPull, then restart.",
    });

    const read = await ok("GET", `/api/documents/${document.id}`, ada);
    expect(read.body).toBe(
      [
        "# Guide",
        "",
        "Welcome.",
        "",
        "## Install",
        "",
        "Use the image.",
        "",
        "### Docker",
        "",
        "docker run cronk",
        "",
        "## Uninstall",
        "",
        "### Linux",
        "",
        "apt remove cronk",
        "",
        "## Upgrade",
        "",
        "Pull, then restart.",
        "",
      ].join("\n"),
    );
  });

  test("a new body that changes the Section's heading level, or starts another Section, is refused", async () => {
    const { ada, asAgent, document } = await workspaceWithGuide();

    for (const body of [
      "### Install\n\nGet it.",
      "# Install\n\nGet it.",
      "Get it.",
      "Get it first.\n\n## Install",
      "## Install\n\nGet it.\n\n## Configure\n\nSet it up.",
      "## Install\n\nGet it.\n\n# Afterwards",
    ]) {
      const refused = await call("PUT", `/api/documents/${document.id}/sections`, asAgent, {
        section: "Install",
        baseVersion: 1,
        body,
      });
      expect(refused.status, body).toBe(400);
      expect(refused.json.error).toEqual(
        expect.objectContaining({ code: "section_heading_level", rule: expect.any(String), advice: expect.any(String) }),
      );
    }
    const read = await ok("GET", `/api/documents/${document.id}`, ada);
    expect(read.version.number).toBe(1);
  });

  test("a replace based on an outdated Version is refused with the current Version", async () => {
    const { ada, asAgent, document } = await workspaceWithGuide();
    await ok("PATCH", `/api/documents/${document.id}`, ada, { baseVersion: 1, body: `${guide}\nAppendix.\n` });

    const refused = await call("PUT", `/api/documents/${document.id}/sections`, asAgent, {
      section: "macOS",
      baseVersion: 1,
      body: "### macOS\n\nport install cronk",
    });

    expect(refused.status).toBe(409);
    expect(refused.json.error).toEqual(
      expect.objectContaining({
        code: "outdated_version",
        current: expect.objectContaining({ number: 2, body: `${guide}\nAppendix.\n` }),
      }),
    );
  });

  test("an ambiguous or missing Section is refused on a replace too, saving nothing", async () => {
    const { ada, asAgent, document } = await workspaceWithGuide();

    const ambiguous = await call("PUT", `/api/documents/${document.id}/sections`, asAgent, {
      section: "Linux",
      baseVersion: 1,
      body: "### Linux\n\nNothing.",
    });
    const missing = await call("PUT", `/api/documents/${document.id}/sections`, asAgent, {
      section: "Windows",
      baseVersion: 1,
      body: "### Windows\n\nNothing.",
    });

    expect([ambiguous.status, ambiguous.json.error.code]).toEqual([409, "section_ambiguous"]);
    expect(ambiguous.json.error.candidates).toEqual(["Guide/Install/Linux", "Guide/Uninstall/Linux"]);
    expect([missing.status, missing.json.error.code]).toEqual([404, "section_not_found"]);
    expect(missing.json.error.headings).toContain("Guide/Install/macOS");
    expect((await ok("GET", `/api/documents/${document.id}`, ada)).version.number).toBe(1);
  });

  test("a read-only token reads a Section but can't replace one", async () => {
    const { asReader, document } = await workspaceWithGuide();

    const read = await ok("GET", sectionPath(document.id, "macOS"), asReader);
    const refused = await call("PUT", `/api/documents/${document.id}/sections`, asReader, {
      section: "macOS",
      baseVersion: 1,
      body: "### macOS\n\nport install cronk",
    });

    expect(read.body).toBe("### macOS\n\nbrew install cronk");
    expect([refused.status, refused.json.error.code]).toEqual([403, "read_only_token"]);
  });

  test("Setext headings and headings with closing marks are Sections; a Document without headings has none", async () => {
    const { ada, project } = await workspaceWithGuide();
    const setext = await ok("POST", `/api/projects/${project.id}/documents`, ada, {
      title: "Notes",
      body: "Notes\r\n=====\r\n\r\nIntro.\r\n\r\nDetails ##\r\n-------\r\n\r\nMore.\r\n",
    });
    const plain = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Plain", body: "No headings." });

    const details = await ok("GET", sectionPath(setext.id, "Notes/Details ##"), ada);
    expect(details).toEqual(expect.objectContaining({ level: 2, body: "Details ##\r\n-------\r\n\r\nMore." }));
    await ok("PUT", `/api/documents/${setext.id}/sections`, ada, {
      section: "Details ##",
      baseVersion: 1,
      body: "## Details\r\n\r\nLess.",
    });
    expect((await ok("GET", `/api/documents/${setext.id}`, ada)).body).toBe(
      "Notes\r\n=====\r\n\r\nIntro.\r\n\r\n## Details\r\n\r\nLess.\r\n",
    );
    const none = await call("GET", sectionPath(plain.id, "Intro"), ada);
    expect([none.status, none.json.error.code, none.json.error.headings]).toEqual([404, "section_not_found", []]);
  });
});
