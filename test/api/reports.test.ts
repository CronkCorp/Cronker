import { afterEach, describe, expect, test } from "vitest";
import { setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk, type StartCronkOptions } from "../harness/start-cronk.js";
import { openStream } from "../harness/stream.js";

let cronk: StartedCronk | undefined;
afterEach(async () => {
  await cronk?.stop();
  cronk = undefined;
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk!.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

/**
 * A Ticket in the Project's Backlog as milestone 1's Cronk created it. Creating one reads the Project's settings, which
 * migrations after the one under test add, so on a database migrated short of it the Ticket is staged instead.
 */
async function stagedTicket(project: { id: string; workspaceId: string; statuses: { id: string; name: string }[] }, userId: string) {
  const id = "5d1e2f30-4a5b-4c6d-8e7f-a0b1c2d3e4f5";
  const backlog = project.statuses.find((s) => s.name === "Backlog")!.id;
  await cronk!.stage(
    `insert into tickets (id, workspace_id, project_id, number, title, description, status_id, created_by, created_at, status_entered_at)
     values ($1, $2, $3, 1, 'Make it so', '', $4, $5, '2026-01-01T09:00:00Z', '2026-01-01T09:00:00Z')`,
    [id, project.workspaceId, project.id, backlog, userId],
  );
  await cronk!.stage("update projects set next_ticket_number = 2 where id = $1", [project.id]);
  return { id };
}

/**
 * Ada with a Project on the default board and a Ticket CRONK-1 her Agent `claude-max` is running a Triage Run on,
 * through her fake Runner.
 */
async function runningRun(options: StartCronkOptions = {}) {
  cronk = await startCronk(options);
  // Setting up, creating a Project and starting its Runs, as today's API does, needs Workspace slugs and the Merge
  // Step's columns and the Repositories a Project lists; setting up a Runner needs the columns of a Managed Agents
  // Runner's setup; reading a Ticket or a Runner needs the columns of Runs' costs; finding a Project or a Ticket
  // needs Access; any User read needs display names; writing a Ticket's description or a Comment needs the Mention index,
  // Embeds, Decision Mentions and Term Mentions among it; finding a Project and starting a Run need Concise Reports; any
  // Access needs archived Projects; reading a Ticket needs Pull Requests' conflict markers and its latest Run's
  // Transcript.
  if (options.migrateBefore !== undefined) {
    await cronk.applyAhead("0022_repositories.sql");
    await cronk.applyAhead("0026_decisions.sql");
    await cronk.applyAhead("0033_merge_step.sql");
    await cronk.applyAhead("0033_transcripts.sql");
    await cronk.applyAhead("0037_transcript_deletions.sql");
    await cronk.applyAhead("0043_managed_agents_runner.sql");
    await cronk.applyAhead("0044_workspace_slugs.sql");
    await cronk.applyAhead("0047_managed_agents_webhooks.sql");
    await cronk.applyAhead("0049_run_costs.sql");
    await cronk.applyAhead("0051_access.sql");
    await cronk.applyAhead("0053_display_name.sql");
    await cronk.applyAhead("0055_mentions.sql");
    await cronk.applyAhead("0057_embeds.sql");
    await cronk.applyAhead("0068_decision_mentions.sql");
    await cronk.applyAhead("0070_term_mentions.sql");
    await cronk.applyAhead("0056_concise_reports.sql");
    await cronk.applyAhead("0057_archived_projects.sql");
    await cronk.applyAhead("0027_pull_requests.sql");
    await cronk.applyAhead("0059_conflict_markers.sql");
    await cronk.applyAhead("0042_merge_conflicts.sql");
    await cronk.applyAhead("0061_merge_queue.sql");
    await cronk.applyAhead("0065_merge_queue_conflicts.sql");
    await cronk.applyAhead("0073_agent_access_undelegated.sql");
    // Reading a Ticket needs its Release.
    await cronk.applyAhead("0075_releases.sql");
    // And its Backport.
    await cronk.applyAhead("0078_backports.sql");
    // Issuing a Write token needs token levels.
    await cronk.applyAhead("0079_token_levels.sql");
    // Reading a Ticket needs its Runs' costs, estimates apart.
    await cronk.applyAhead("0084_cost_estimates.sql");
    // Adding a Runner needs its allowlist.
    await cronk.applyAhead("0085_runner_allowlists.sql");
    // Reading whether a `local` Runner is offline needs its Machines' connections.
    await cronk.applyAhead("0082_machines.sql");
    await cronk.applyAhead("0088_machine_connections.sql");
  }
  const { user, workspace } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket =
    options.migrateBefore === undefined
      ? await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" })
      : await stagedTicket(project, user.id);
  const runner = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "write" });
  const triage = project.statuses.find((s: { name: string }) => s.name === "Triage").id as string;
  await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: triage });
  // The Run as the fake Runner was asked to start it: reading it through the API would read tables a database
  // migrated short of today's migrations lacks.
  const run = { id: cronk.runner.starts.at(-1)!.runId };
  const asAgent = { headers: { authorization: `Bearer ${secret}` } };
  return { workspace, ada, project, ticket, agent, run, asAgent };
}

describe("milestone 1's Reports moved into Documents", () => {
  test("each Report survives with its title, body, Agent, Run and time, as a Document with one Version by its Agent", async () => {
    const { ada, project, ticket, agent, run } = await runningRun({ migrateBefore: "0022_reports_documents.sql" });
    // Two Reports milestone 1 wrote at the same instant, which keep the order they were written in.
    const findings = "8c1f5a52-6f0e-4a8e-9d43-1b2c3d4e5f60";
    const plan = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";
    for (const [id, title, body] of [
      [findings, "Findings", "The bug is in **parsing**."],
      [plan, "Plan", "Fix the parser."],
    ]) {
      await cronk!.stage(
        `insert into reports (id, workspace_id, ticket_id, run_id, agent_id, title, body, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, '2026-01-01T09:30:00Z')`,
        [id, project.workspaceId, ticket.id, run.id, agent.id, title, body],
      );
    }

    await cronk!.upgrade();

    const byAgent = { id: agent.id, name: "claude-max" };
    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, ada)).toEqual([
      {
        id: findings,
        ticketId: ticket.id,
        runId: run.id,
        agent: byAgent,
        title: "Findings",
        slug: `findings-${findings.slice(0, 8)}`,
        body: "The bug is in **parsing**.",
        createdAt: "2026-01-01T09:30:00.000Z",
        mentions: [], threads: [],
      },
      {
        id: plan,
        ticketId: ticket.id,
        runId: run.id,
        agent: byAgent,
        title: "Plan",
        slug: `plan-${plan.slice(0, 8)}`,
        body: "Fix the parser.",
        createdAt: "2026-01-01T09:30:00.000Z",
        mentions: [], threads: [],
      },
    ]);
    expect(await ok("GET", `/api/documents/${findings}/versions`, ada)).toEqual([
      { number: 1, title: "Findings", actor: { kind: "agent", ...byAgent }, savedAt: "2026-01-01T09:30:00.000Z" },
    ]);
    // Listed with the Ticket instead of in a page tree.
    expect(await ok("GET", `/api/projects/${project.id}/documents`, ada)).toEqual([]);
  });
});

describe("Reports as Documents", () => {
  test("a Report a Run writes is a Document on its Ticket and Run, at Version 1 by its Agent", async () => {
    const { ada, project, ticket, agent, run, asAgent } = await runningRun();

    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, {
      title: "Findings",
      body: "The bug is in **parsing**.",
    });

    const byAgent = { kind: "agent", id: agent.id, name: "claude-max" };
    expect(await ok("GET", `/api/documents/${report.id}`, ada)).toEqual({
      id: report.id,
      workspaceId: project.workspaceId,
      projectId: project.id,
      ticketId: ticket.id,
      runId: run.id,
      parentId: null,
      position: null,
      title: "Findings",
      slug: `findings-${report.id.slice(0, 8)}`,
      body: "The bug is in **parsing**.",
      version: { number: 1, title: "Findings", actor: byAgent, savedAt: "2026-01-01T09:00:00.000Z" },
      mentions: [],
      comments: [],
    });
  });

  test("saving a Report makes its next Version, which the Ticket's Reports then show", async () => {
    const { ada, ticket, run, agent, asAgent } = await runningRun();
    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, { title: "Findings", body: "Parsing." });
    cronk!.clock.advance(60_000);

    const saved = await ok("PATCH", `/api/documents/${report.id}`, ada, { baseVersion: 1, body: "Parsing, in `lex()`." });

    expect(saved.version).toEqual(expect.objectContaining({ number: 2, actor: expect.objectContaining({ kind: "user" }) }));
    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, ada)).toEqual([
      {
        id: report.id,
        ticketId: ticket.id,
        runId: run.id,
        agent: { id: agent.id, name: "claude-max" },
        title: "Findings",
        slug: `findings-${report.id.slice(0, 8)}`,
        body: "Parsing, in `lex()`.",
        createdAt: "2026-01-01T09:00:00.000Z",
        mentions: [], threads: [],
      },
    ]);
    const versions = await ok("GET", `/api/documents/${report.id}/versions`, ada);
    expect(versions.map((v: { number: number; actor: { kind: string } }) => [v.number, v.actor.kind])).toEqual([
      [1, "agent"],
      [2, "user"],
    ]);
  });

  test("a Report carries Attachments, by a User and by its Run's Agent, as any Document does", async () => {
    const { ada, ticket, asAgent } = await runningRun();
    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, { title: "Findings", body: "See the log." });
    const attach = async (as: Request, name: string) => {
      const response = await fetch(new URL(`/api/documents/${report.id}/attachments?name=${name}`, cronk!.url), {
        method: "POST",
        headers: { ...as.headers, ...(as.cookie ? { cookie: as.cookie } : {}), "content-type": "text/plain" },
        body: "42 passed",
      });
      expect(response.status, await response.clone().text()).toBe(201);
      return response.json();
    };

    const byAgent = await attach(asAgent, "agent.log");
    cronk!.clock.advance(60_000);
    const byAda = await attach(ada, "ada.log");

    expect(byAgent).toMatchObject({ name: "agent.log", on: { kind: "document", id: report.id } });
    expect(await ok("GET", `/api/documents/${report.id}/attachments`, ada)).toEqual([byAgent, byAda]);
  });

  test("saving or deleting a Report tells the Workspace's streams, so its Ticket shows it", async () => {
    const { workspace, ada, project, ticket, asAgent } = await runningRun();
    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, { title: "Findings", body: "…" });
    const stream = await openStream(cronk!, ada.cookie!, workspace.id);
    const changed = { type: "report.changed", data: { projectId: project.id, ticketId: ticket.id, reportId: report.id } };

    await ok("PATCH", `/api/documents/${report.id}`, asAgent, { baseVersion: 1, body: "More." });
    expect(await stream.next()).toEqual(changed);
    await ok("DELETE", `/api/documents/${report.id}`, ada);
    expect(await stream.next()).toEqual(changed);
    expect(await ok("GET", `/api/tickets/${ticket.id}/reports`, ada)).toEqual([]);
    stream.close();
  });

  test("a Report stays out of page trees: it can't move into one, nor hold a Document under it", async () => {
    const { ada, project, ticket, asAgent } = await runningRun();
    const report = await ok("POST", `/api/tickets/${ticket.id}/reports`, asAgent, { title: "Findings", body: "…" });
    const page = await ok("POST", `/api/projects/${project.id}/documents`, ada, { title: "Architecture", body: "" });

    for (const move of [{ parentId: page.id }, { parentId: null }, { position: 0 }]) {
      const refused = await call("PATCH", `/api/documents/${report.id}`, ada, move);
      expect(refused.status, JSON.stringify(move)).toBe(409);
      expect(refused.json.error).toEqual(expect.objectContaining({ code: "report_outside_tree" }));
    }
    const under = await call("POST", `/api/projects/${project.id}/documents`, ada, {
      title: "Notes",
      body: "",
      parentId: report.id,
    });
    expect(under.status).toBe(409);
    expect(under.json.error.code).toBe("parent_outside_tree");
    expect((await ok("GET", `/api/projects/${project.id}/documents`, ada)).map((d: { id: string }) => d.id)).toEqual([page.id]);
  });
});
