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

async function ok(method: string, path: string, as: As, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  const json = response.status === 204 ? null : await response.json();
  expect(response.status, `${method} ${path}: ${JSON.stringify(json)}`).toBeLessThan(300);
  return json;
}

/**
 * Ada's Workspace with a Project CRONK, whose Ticket CRONK-1 her Agent `claude-max` is running a Triage Run on, and a
 * glossary: the Workspace's Term Ticket avoids `task` and `issue`, Project avoids `repo`; CRONK's own Term Issue
 * replaces nothing but makes `issue` a Term's own name there, and its Term Board avoids `kanban` and `to do list`.
 */
async function workspaceWithGlossary() {
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };

  await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, { name: "Ticket", avoid: ["task", "issue"] });
  await ok("POST", `/api/workspaces/${workspace.id}/terms`, ada, { name: "Project", avoid: ["repo"] });
  await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Issue" });
  await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Board", avoid: ["kanban", "to do list"] });
  return { workspace, ada, project, ticket, agent, asAgent };
}

const ticketTerm = { name: "Ticket", readable: "Ticket" };
const boardTerm = { name: "Board", readable: "CRONK/Board" };

describe("avoided-word warnings on an Agent's saves", () => {
  test("creating a Document lists each avoided word its title and body use, once, with the Term to use, and saves it", async () => {
    const { project, asAgent, ada } = await workspaceWithGlossary();

    const created = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, {
      title: "Task list",
      body: "Each task goes on the Kanban.\n\nTasks move along; another TASK waits.",
    });

    expect(created.avoidedWords).toEqual([
      { word: "Task", term: ticketTerm },
      { word: "Kanban", term: boardTerm },
    ]);
    expect((await ok("GET", `/api/documents/${created.id}`, ada)).body).toBe(
      "Each task goes on the Kanban.\n\nTasks move along; another TASK waits.",
    );
  });

  test("words are matched whole, ignoring case, and phrases across any white space", async () => {
    const { project, asAgent } = await workspaceWithGlossary();

    const created = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, {
      title: "Notes",
      body: "Multitasking, repository and tasks. Keep a to do\nlist.",
    });

    expect(created.avoidedWords).toEqual([
      { word: "to do\nlist", term: boardTerm },
    ]);
    const plural = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, { title: "Tasks", body: "" });
    expect(plural.avoidedWords).toEqual([]);
  });

  test("words in code spans, code blocks, block quotes, raw HTML and link targets don't warn; link text does", async () => {
    const { project, asAgent } = await workspaceWithGlossary();

    const created = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, {
      title: "Quoting",
      body: [
        "Run `task build` first.",
        "",
        "```",
        "kanban --repo here",
        "```",
        "",
        "> The user said: put the task on the kanban.",
        "",
        "See [the board](https://example.com/task/kanban) and <https://example.com/repo>.",
        "",
        "<div class=\"task\"></div>",
        "",
        "Open [the repo](https://example.com).",
      ].join("\n"),
    });

    expect(created.avoidedWords).toEqual([{ word: "repo", term: { name: "Project", readable: "Project" } }]);
  });

  test("a clean save has an empty list", async () => {
    const { project, asAgent } = await workspaceWithGlossary();

    const created = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, { title: "Board", body: "Each Ticket." });

    expect(created.avoidedWords).toEqual([]);
  });

  test("Project text uses the Project's Terms over the Workspace's, and a Term's own name there never warns", async () => {
    const { project, asAgent } = await workspaceWithGlossary();

    const created = await ok("POST", `/api/projects/${project.id}/documents`, asAgent, {
      title: "Plan",
      body: "File an issue, not a task, on the kanban.",
    });

    // `issue` is the Project's own Term Issue's name, so only Ticket's `task` and Board's `kanban` warn.
    expect(created.avoidedWords).toEqual([
      { word: "task", term: ticketTerm },
      { word: "kanban", term: boardTerm },
    ]);
  });

  test("Workspace text uses only the Workspace's glossary", async () => {
    const { workspace, asAgent } = await workspaceWithGlossary();

    const created = await ok("POST", `/api/workspaces/${workspace.id}/documents`, asAgent, {
      title: "Handbook",
      body: "File an issue on the kanban.",
    });

    expect(created.avoidedWords).toEqual([{ word: "issue", term: ticketTerm }]);
  });

  test("editing a Document checks the title and body it saves; a move checks nothing", async () => {
    const { project, asAgent, ada } = await workspaceWithGlossary();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Task", body: "A task." });

    const saved = await ok("PATCH", `/api/documents/${document.id}`, asAgent, { baseVersion: 1, body: "On the kanban." });
    expect(saved.avoidedWords).toEqual([{ word: "kanban", term: boardTerm }]);
    expect(saved.version.number).toBe(2);

    const renamed = await ok("PATCH", `/api/documents/${document.id}`, asAgent, { baseVersion: 2, title: "Repo" });
    expect(renamed.avoidedWords).toEqual([{ word: "Repo", term: { name: "Project", readable: "Project" } }]);

    const moved = await ok("PATCH", `/api/documents/${document.id}`, asAgent, { position: 0 });
    expect(moved.avoidedWords).toEqual([]);
  });

  test("replacing a Section checks its new body", async () => {
    const { project, asAgent, ada } = await workspaceWithGlossary();
    const document = await ok("POST", `/api/projects/${project.id}/documents`, ada, {
      title: "Guide",
      body: "# Install\n\nA task.\n\n# Use\n\nIt works.",
    });

    const replaced = await ok("PUT", `/api/documents/${document.id}/sections`, asAgent, {
      section: "Use",
      baseVersion: 1,
      body: "# Use\n\nDrag each task across the kanban.",
    });

    expect(replaced).toEqual(
      expect.objectContaining({
        path: "Use",
        avoidedWords: [
          { word: "task", term: ticketTerm },
          { word: "kanban", term: boardTerm },
        ],
      }),
    );
  });

  test("writing a Report checks its title and body by its Ticket's Project's glossary", async () => {
    const { ada, project, ticket, agent, asAgent } = await workspaceWithGlossary();
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });

    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, {
      title: "Findings",
      body: "The repo has an issue: tasks pile up on the kanban.",
    });

    expect(report.avoidedWords).toEqual([
      { word: "repo", term: { name: "Project", readable: "Project" } },
      { word: "kanban", term: boardTerm },
    ]);
  });

  test("every other text an Agent saves warns by the glossary of its place; the same save by a User never does", async () => {
    const { workspace, ada, project, ticket, agent, asAgent } = await workspaceWithGlossary();
    const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
    const [run] = await ok("GET", `/api/tickets/${ticket.id}/runs`, ada);
    const page = [{ path: "index.html", contentBase64: Buffer.from("<p>Hi</p>").toString("base64") }];
    const projectTerm = { name: "Project", readable: "Project" };
    const term = await ok("POST", `/api/projects/${project.id}/terms`, ada, { name: "Lane" });
    const decision = await ok("POST", `/api/projects/${project.id}/decisions`, ada, { title: "Lanes" });
    const artifact = await ok("POST", `/api/projects/${project.id}/artifacts`, ada, { title: "Board", files: page });
    const spec = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Spec", body: "On the kanban." });
    const guide = await ok("POST", `/api/workspaces/${workspace.id}/documents`, ada, { title: "Guide", body: "" });
    const current = async (path: string) => ({ baseVersion: (await ok("GET", path, ada)).version.number as number });

    type Save = { name: string; save: (as: As, agent: boolean) => Promise<{ avoidedWords?: unknown }>; expected: unknown[] };
    const saves: Save[] = [
      {
        name: "filing a Ticket, title and description together",
        save: (as, agent) =>
          ok("POST", `/api/projects/${project.id}/tickets`, as, {
            title: "Task",
            description: "On the kanban, another task.",
            ...(agent ? { runId: run.id } : {}),
          }),
        expected: [
          { word: "Task", term: ticketTerm },
          { word: "kanban", term: boardTerm },
        ],
      },
      {
        name: "creating a Sub-Ticket",
        save: (as) => ok("POST", `/api/projects/${project.id}/tickets`, as, { title: "Repo cleanup", parentId: ticket.id }),
        expected: [{ word: "Repo", term: projectTerm }],
      },
      {
        name: "editing a Ticket checks only what it gives",
        save: (as) => ok("PATCH", `/api/tickets/${ticket.id}`, as, { description: "Move it along the kanban." }),
        expected: [{ word: "kanban", term: boardTerm }],
      },
      {
        name: "commenting on a Ticket",
        save: (as) => ok("POST", `/api/tickets/${ticket.id}/comments`, as, { body: "A task." }),
        expected: [{ word: "task", term: ticketTerm }],
      },
      {
        name: "commenting on an Artifact",
        save: (as) => ok("POST", `/api/artifacts/${artifact.id}/comments`, as, { body: "The kanban." }),
        expected: [{ word: "kanban", term: boardTerm }],
      },
      {
        name: "commenting on a Document, quoting a passage",
        save: (as) =>
          ok("POST", `/api/documents/${spec.id}/comments`, as, { body: "Each task, not a repo.", quote: "the kanban" }),
        expected: [
          { word: "task", term: ticketTerm },
          { word: "repo", term: projectTerm },
        ],
      },
      {
        name: "commenting on a Workspace Document uses only the Workspace's glossary",
        save: (as) => ok("POST", `/api/documents/${guide.id}/comments`, as, { body: "On the kanban, a task." }),
        expected: [{ word: "task", term: ticketTerm }],
      },
      {
        name: "creating a Project Term",
        save: (as, agent) =>
          ok("POST", `/api/projects/${project.id}/terms`, as, { name: agent ? "Column" : "Row", definition: "On the kanban." }),
        expected: [{ word: "kanban", term: boardTerm }],
      },
      {
        name: "creating a Workspace Term uses only the Workspace's glossary",
        save: (as, agent) =>
          ok("POST", `/api/workspaces/${workspace.id}/terms`, as, {
            name: agent ? "Column" : "Row",
            definition: "A kanban column, not a task.",
          }),
        expected: [{ word: "task", term: ticketTerm }],
      },
      {
        name: "editing a Term",
        save: async (as) =>
          ok("PATCH", `/api/terms/${term.id}`, as, { ...(await current(`/api/terms/${term.id}`)), definition: "A repo." }),
        expected: [{ word: "repo", term: projectTerm }],
      },
      {
        name: "proposing a Decision",
        save: (as) => ok("POST", `/api/projects/${project.id}/decisions`, as, { title: "Use a kanban", body: "Each task." }),
        expected: [
          { word: "kanban", term: boardTerm },
          { word: "task", term: ticketTerm },
        ],
      },
      {
        name: "editing a Decision",
        save: async (as) =>
          ok("PATCH", `/api/decisions/${decision.id}`, as, { ...(await current(`/api/decisions/${decision.id}`)), body: "In the repo." }),
        expected: [{ word: "repo", term: projectTerm }],
      },
      {
        name: "creating an Artifact",
        save: (as) =>
          ok("POST", `/api/projects/${project.id}/artifacts`, as, { title: "Kanban", description: "Each task.", files: page }),
        expected: [
          { word: "Kanban", term: boardTerm },
          { word: "task", term: ticketTerm },
        ],
      },
      {
        name: "saving an Artifact",
        save: async (as) =>
          ok("PATCH", `/api/artifacts/${artifact.id}`, as, { ...(await current(`/api/artifacts/${artifact.id}`)), title: "Repo board" }),
        expected: [{ word: "Repo", term: projectTerm }],
      },
    ];

    for (const { name, save, expected } of saves) {
      expect((await save(asAgent, true)).avoidedWords, name).toEqual(expected);
      expect(await save(ada, false), name).not.toHaveProperty("avoidedWords");
    }

    const finished = await ok("POST", `/api/runs/${run.id}/finish`, asAgent, {
      outcome: "needs you",
      report: "The repo is fine.",
      question: "Which kanban?",
    });
    expect(finished.avoidedWords).toEqual([
      { word: "repo", term: projectTerm },
      { word: "kanban", term: boardTerm },
    ]);
  });

  test("a User's saves never warn", async () => {
    const { project, ada } = await workspaceWithGlossary();

    const created = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Task", body: "A task." });
    const saved = await ok("PATCH", `/api/documents/${created.id}`, ada, { baseVersion: 1, body: "# Kanban\n\nA task." });
    const replaced = await ok("PUT", `/api/documents/${created.id}/sections`, ada, {
      section: "Kanban",
      baseVersion: 2,
      body: "# Kanban\n\nAnother task.",
    });

    for (const response of [created, saved, replaced]) expect(response).not.toHaveProperty("avoidedWords");
  });
});

