import { afterEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

/**
 * Wherever the API takes the id of a Workspace, Project, Ticket, Decision, Term, Document, Artifact or Transcript, it
 * also takes the readable form its web address uses, resolved among what the caller sees.
 */

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

/** Ada's Workspace (`adas-workspace`) with a Project RP, its Ticket RP-1, and a Write token of her Agent `claude-max`. */
async function workspaceWithTicket() {
  cronk = await startCronk();
  const { workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Roadmap", key: "RP" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Readable addresses" });
  const agent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "laptop", access: "write" });
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, ada, project, ticket, agent, asAgent };
}

describe("Workspaces", () => {
  test("a Workspace's slug works wherever its id does", async () => {
    const { workspace, ada, asAgent } = await workspaceWithTicket();

    expect((await ok("GET", "/api/workspaces/adas-workspace", ada)).id).toBe(workspace.id);
    expect((await ok("GET", "/api/workspaces/ADAS-Workspace", asAgent)).id).toBe(workspace.id);
    expect((await ok("GET", "/api/workspaces/adas-workspace/projects", ada)).map((p: { key: string }) => p.key)).toEqual(["RP"]);
    expect((await ok("PATCH", "/api/workspaces/adas-workspace", ada, { name: "Lab" })).slug).toBe("adas-workspace");
    expect((await call("GET", "/api/workspaces/someone-elses", ada)).status).toBe(404);
  });
});

describe("Tickets", () => {
  test("a Ticket's key, in any letter case, works wherever its id does", async () => {
    const { ada, ticket, asAgent } = await workspaceWithTicket();

    expect((await ok("GET", "/api/tickets/RP-1", ada)).id).toBe(ticket.id);
    expect((await ok("GET", "/api/tickets/rp-1", asAgent)).id).toBe(ticket.id);
    expect((await ok("PATCH", "/api/tickets/Rp-1", ada, { title: "Readable" })).title).toBe("Readable");
    await ok("POST", "/api/tickets/RP-1/comments", ada, { body: "By its key" });
    expect((await ok("GET", `/api/tickets/${ticket.id}/comments`, ada)).map((c: { body: string }) => c.body)).toEqual(["By its key"]);
    expect((await call("GET", "/api/tickets/RP-2", ada)).status).toBe(404);
  });

  test("a key two of a User's Workspaces share needs its Workspace's slug in front", async () => {
    const { ada, ticket } = await workspaceWithTicket();
    const other = await ok("POST", "/api/workspaces", ada, { name: "Other" });
    const otherProject = await ok("POST", `/api/workspaces/${other.id}/projects`, ada, { name: "Rival", key: "RP" });
    const otherTicket = await ok("POST", `/api/projects/${otherProject.id}/tickets`, ada, { title: "Same key" });

    expect((await call("GET", "/api/tickets/RP-1", ada)).status).toBe(404);
    expect((await ok("GET", "/api/tickets/adas-workspace%2FRP-1", ada)).id).toBe(ticket.id);
    expect((await ok("GET", "/api/tickets/other%2Frp-1", ada)).id).toBe(otherTicket.id);
  });

  test("a Ticket's key names nothing in a Workspace the caller doesn't belong to", async () => {
    const { ada, workspace } = await workspaceWithTicket();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    await ok("POST", "/api/workspaces", { cookie: bea.cookie }, { name: "Bea's" });
    await ok("DELETE", `/api/workspaces/${workspace.id}/members/${bea.user.id}`, ada);

    expect((await call("GET", "/api/tickets/RP-1", { cookie: bea.cookie })).status).toBe(404);
    expect((await call("GET", "/api/tickets/adas-workspace%2FRP-1", { cookie: bea.cookie })).status).toBe(404);
  });
});

describe("Projects", () => {
  test("a Project's key, in any letter case, works wherever its id does", async () => {
    const { ada, project, asAgent } = await workspaceWithTicket();

    expect((await ok("GET", "/api/projects/RP", ada)).id).toBe(project.id);
    expect((await ok("GET", "/api/projects/rp", asAgent)).id).toBe(project.id);
    expect((await ok("GET", "/api/projects/adas-workspace%2Frp", ada)).id).toBe(project.id);
    expect((await ok("GET", "/api/projects/RP/tickets", ada)).map((t: { key: string }) => t.key)).toEqual(["RP-1"]);
    expect((await call("GET", "/api/projects/XX", ada)).status).toBe(404);
  });
});

describe("Decisions", () => {
  test("a Decision's number works within its Project, or among the Workspace's own", async () => {
    const { ada, asAgent } = await workspaceWithTicket();
    const own = await ok("POST", "/api/workspaces/adas-workspace/decisions", ada, { title: "Workspace slugs in addresses" });
    const first = await ok("POST", "/api/projects/RP/decisions", ada, { title: "Keys never change" });
    const second = await ok("POST", "/api/projects/RP/decisions", ada, { title: "Tickets never move" });

    expect((await ok("GET", "/api/decisions/1", ada)).id).toBe(own.id);
    expect((await ok("GET", "/api/decisions/adas-workspace%2F1", ada)).id).toBe(own.id);
    expect((await ok("GET", "/api/decisions/RP%2F1", asAgent)).id).toBe(first.id);
    expect((await ok("GET", "/api/decisions/adas-workspace%2Frp%2F2", ada)).id).toBe(second.id);
    expect((await ok("GET", "/api/decisions/RP%2F2/versions", ada)).map((v: { number: number }) => v.number)).toEqual([1]);
    const superseded = await ok("PATCH", "/api/decisions/RP%2F1", ada, { baseVersion: 1, status: "superseded", supersededById: "RP/2" });
    expect(superseded.supersededById).toBe(second.id);
    expect((await call("GET", "/api/decisions/RP%2F3", ada)).status).toBe(404);
  });
});

describe("Terms", () => {
  test("a Term's name, ignoring case, works within its Project's glossary or the Workspace's", async () => {
    const { ada, asAgent } = await workspaceWithTicket();
    const own = await ok("POST", "/api/workspaces/adas-workspace/terms", ada, { name: "Workspace slug", definition: "Its name in addresses." });
    const projects = await ok("POST", "/api/projects/RP/terms", ada, { name: "CI/CD", definition: "Builds and ships." });
    const shadow = await ok("POST", "/api/projects/RP/terms", ada, { name: "Workspace slug", definition: "The same, here." });

    expect((await ok("GET", "/api/terms/RP%2Fci%2Fcd", asAgent)).id).toBe(projects.id);
    expect((await call("GET", "/api/terms/CI%2FCD", ada)).status).toBe(404);
    expect((await ok("GET", "/api/terms/workspace%20slug", ada)).id).toBe(own.id);
    expect((await ok("GET", "/api/terms/rp%2FWorkspace%20Slug", ada)).id).toBe(shadow.id);
    expect((await ok("GET", "/api/terms/adas-workspace%2FRP%2FWorkspace%20slug", ada)).id).toBe(shadow.id);
    expect((await call("GET", "/api/terms/Nothing", ada)).status).toBe(404);
  });
});

/** The short id at a slug's end, which names it: the first 8 hex digits of its id. */
const shortIdOf = (id: string) => id.slice(0, 8);

describe("Documents, Artifacts and Transcripts", () => {
  test("a Document's slug, the words of its title and its short id, works wherever its id does, its words or not", async () => {
    const { ada, asAgent } = await workspaceWithTicket();
    const document = await ok("POST", "/api/projects/RP/documents", ada, { title: "Onboarding: Day One!", body: "Hello" });
    const slug = `onboarding-day-one-${shortIdOf(document.id)}`;
    expect(document.slug).toBe(slug);
    const child = await ok("POST", "/api/projects/RP/documents", ada, { title: "Ünder it", parentId: slug });
    expect(child.parentId).toBe(document.id);
    expect(child.slug).toBe(`under-it-${shortIdOf(child.id)}`);

    expect((await ok("GET", `/api/documents/${slug}`, asAgent)).id).toBe(document.id);
    expect((await ok("GET", `/api/documents/${shortIdOf(document.id)}`, ada)).id).toBe(document.id);
    expect((await ok("GET", `/api/documents/an-old-title-${shortIdOf(document.id)}`, ada)).id).toBe(document.id);
    const renamed = await ok("PATCH", `/api/documents/${slug}`, ada, { baseVersion: 1, title: "First day" });
    expect(renamed.slug).toBe(`first-day-${shortIdOf(document.id)}`);
    await ok("POST", "/api/tickets/RP-1/documents", ada, { documentId: renamed.slug });
    expect(await ok("GET", "/api/tickets/RP-1/documents", ada)).toEqual([expect.objectContaining({ id: document.id, slug: renamed.slug })]);
    expect((await call("GET", `/api/documents/onboarding-${document.id.slice(0, 7)}`, ada)).status).toBe(404);
  });

  test("an Artifact's slug works wherever its id does", async () => {
    const { ada } = await workspaceWithTicket();
    const files = [{ path: "index.html", contentBase64: Buffer.from("<p>Hi</p>").toString("base64") }];
    const artifact = await ok("POST", "/api/projects/RP/artifacts", ada, { title: "Board prototype", files });
    const slug = `board-prototype-${shortIdOf(artifact.id)}`;
    expect(artifact.slug).toBe(slug);

    expect((await ok("GET", `/api/artifacts/${slug}`, ada)).id).toBe(artifact.id);
    expect((await ok("GET", `/api/artifacts/prototype-${shortIdOf(artifact.id)}/versions`, ada))).toHaveLength(1);
    await ok("POST", "/api/tickets/RP-1/artifacts", ada, { artifactId: slug });
    expect(await ok("GET", "/api/tickets/RP-1/artifacts", ada)).toEqual([expect.objectContaining({ id: artifact.id, slug })]);
  });

  test("a Transcript's slug, from its Agent's name, works wherever its id does", async () => {
    const { ada, asAgent, workspace } = await workspaceWithTicket();
    const line = { type: "user", sessionId: "s", uuid: "u-1", timestamp: "2026-01-01T09:00:00.000Z", message: { role: "user", content: "Hi" } };
    const uploaded = await fetch(`${cronk.url}/api/transcripts/sessions/session-1`, {
      method: "PUT",
      headers: { "content-type": "application/x-ndjson", ...asAgent.headers },
      body: JSON.stringify(line) + "\n",
    });
    const transcript = await uploaded.json();
    const slug = `claude-max-${shortIdOf(transcript.id)}`;
    expect(transcript.slug).toBe(slug);
    expect(transcript.workspaceId).toBe(workspace.id);

    expect((await ok("GET", `/api/transcripts/${slug}`, ada)).id).toBe(transcript.id);
    expect((await ok("GET", `/api/transcripts/${shortIdOf(transcript.id)}/entries`, ada)).entries).toHaveLength(1);
  });
});

describe("Search results", () => {
  test("carry what each one's address is built from", async () => {
    const { ada } = await workspaceWithTicket();
    await ok("PATCH", "/api/tickets/RP-1", ada, { description: "About zebras" });
    const document = await ok("POST", "/api/projects/RP/documents", ada, { title: "Zebras", body: "Stripes" });
    const decision = await ok("POST", "/api/projects/RP/decisions", ada, { title: "Zebras stay", body: "Stripes" });
    await ok("POST", "/api/workspaces/adas-workspace/terms", ada, { name: "Zebra", definition: "Striped." });

    const results = await ok("GET", "/api/workspaces/adas-workspace/search?q=zebras", ada);

    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "ticket", ticketKey: "RP-1", slug: null, number: null }),
        expect.objectContaining({ kind: "document", id: document.id, slug: document.slug, number: null }),
        expect.objectContaining({ kind: "decision", id: decision.id, slug: null, number: 1 }),
        expect.objectContaining({ kind: "term", title: "Zebra", slug: null, number: null }),
      ]),
    );
  });
});
