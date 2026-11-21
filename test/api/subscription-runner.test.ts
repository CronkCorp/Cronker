import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

interface Request {
  cookie?: string;
  headers?: Record<string, string>;
}

async function call(method: string, path: string, as: Request, body?: unknown) {
  const response = await cronk.request(method, path, { ...as, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, as: Request, body?: unknown) {
  const response = await call(method, path, as, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

const haikuToken = "sk-ant-oat01-haiku-secret";

/**
 * Ada with a Project on the default board (Triage wants haiku), a Ticket in Backlog, and her Agent
 * `claude-max` using her subscription Runner, which has a trigger for haiku that claude.ai knows.
 */
async function adaWithSubscriptionRunner() {
  const { workspace, user } = await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Make it so" });
  const runner = await ok("POST", "/api/runners", ada, { name: "Claude Max", kind: "subscription" });
  cronk.claude.trigger("trig_haiku", haikuToken);
  await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
    model: "haiku",
    triggerId: "trig_haiku",
    token: haikuToken,
  });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: runner.id });
  const { secret } = await ok("POST", `/api/agents/${agent.id}/tokens`, ada, { name: "cloud", access: "full" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const inbox = () => ok("GET", `/api/workspaces/${workspace.id}/inbox`, ada);
  return { workspace, user, ada, project, ticket, runner, agent, agentToken: secret as string, status, inbox };
}

const runsOf = (ticketId: string, as: Request) => ok("GET", `/api/tickets/${ticketId}/runs`, as);

describe("starting a Run", () => {
  test("fires the trigger for the Step's model with the Run's Brief as its text, and the Run shows its claude.ai session", async () => {
    const { ada, ticket, agent, status } = await adaWithSubscriptionRunner();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const [run] = await runsOf(ticket.id, ada);
    const brief = await ok("GET", `/api/runs/${run.id}/brief`, ada);
    expect(cronk.claude.fires).toHaveLength(1);
    const [fire] = cronk.claude.fires;
    expect(fire!.triggerId).toBe("trig_haiku");
    expect(fire!.token).toBe(haikuToken);
    expect(fire!.headers["anthropic-beta"]).toBe("experimental-cc-routine-2026-04-01");
    expect(fire!.body).toEqual({ text: brief.text });
    expect(run).toEqual(
      expect.objectContaining({
        state: "running",
        model: "haiku",
        sessionUrl: "https://claude.ai/code/session_01STANDIN",
        transcriptId: null,
      }),
    );
  });

  test("a Project's own trigger for the model overrides the Runner's, on that Project's Tickets only", async () => {
    const { workspace, ada, project, ticket, runner, agent, status } = await adaWithSubscriptionRunner();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
    const otherTicket = await ok("POST", `/api/projects/${other.id}/tickets`, ada, { title: "Elsewhere" });
    cronk.claude.trigger("trig_cronker_haiku", "sk-ant-oat01-cronker");
    await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "Haiku",
      projectId: project.id,
      triggerId: "trig_cronker_haiku",
      token: "sk-ant-oat01-cronker",
    });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const otherTriage = other.statuses.find((s: { name: string }) => s.name === "Triage").id;
    await ok("PATCH", `/api/tickets/${otherTicket.id}`, ada, { delegateId: agent.id, statusId: otherTriage });

    expect(cronk.claude.fires.map((f) => [f.triggerId, f.token])).toEqual([
      ["trig_cronker_haiku", "sk-ant-oat01-cronker"],
      ["trig_haiku", haikuToken],
    ]);
  });

  test("fires the trigger of the Step's own model", async () => {
    const { ada, ticket, runner, agent, status } = await adaWithSubscriptionRunner();
    cronk.claude.trigger("trig_sonnet", "sk-ant-oat01-sonnet");
    await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "sonnet",
      triggerId: "trig_sonnet",
      token: "sk-ant-oat01-sonnet",
    });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Investigate") });

    expect(cronk.claude.fires.map((f) => f.triggerId)).toEqual(["trig_sonnet"]);
    expect((await runsOf(ticket.id, ada))[0].model).toBe("sonnet");
  });

  test("puts no Cronk token or trigger token in the fire's text", async () => {
    const { ada, ticket, agent, agentToken, status } = await adaWithSubscriptionRunner();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    const text = cronk.claude.fires[0]!.body.text as string;
    expect(text).toContain("CRONK-1");
    expect(text).not.toContain(agentToken);
    expect(text).not.toContain(haikuToken);
    expect(text).not.toContain(ada.cookie.split("=")[1]);
    expect(text).not.toMatch(/cronk_[A-Za-z0-9_-]{16,}|sk-ant-/);
  });
});

describe("cost", () => {
  test("a subscription Run reports no cost: the Run, its Ticket and its Runner show none", async () => {
    const { ada, ticket, agent, agentToken, status } = await adaWithSubscriptionRunner();
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const [run] = await runsOf(ticket.id, ada);

    await ok("POST", `/api/runs/${run.id}/finish`, { headers: { authorization: `Bearer ${agentToken}` } }, { outcome: "ready" });

    expect((await ok("GET", `/api/runs/${run.id}`, ada)).cost).toBeNull();
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).cost).toEqual([]);
    expect((await ok("GET", "/api/runners", ada))[0].costThisMonth).toEqual([]);
  });
});

describe("Runner settings", () => {
  test("list the triggers per model and Project override, never their tokens", async () => {
    const { ada, project, runner } = await adaWithSubscriptionRunner();
    const saved = await call("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "opus",
      projectId: project.id,
      triggerId: "trig_opus_cronker",
      token: "sk-ant-oat01-opus-secret",
    });
    expect(saved.status).toBe(200);

    const listed = await ok("GET", "/api/runners", ada);
    expect(listed).toEqual([
      expect.objectContaining({
        id: runner.id,
        kind: "subscription",
        limit: 2,
        pausedUntil: null,
        triggers: [
          {
            id: expect.any(String),
            model: "haiku",
            projectId: null,
            triggerId: "trig_haiku",
            waitingForToken: false,
            routineUrl: "https://claude.ai/code/routines/trig_haiku",
            createdAt: expect.any(String),
          },
          {
            id: expect.any(String),
            model: "opus",
            projectId: project.id,
            triggerId: "trig_opus_cronker",
            waitingForToken: false,
            routineUrl: "https://claude.ai/code/routines/trig_opus_cronker",
            createdAt: expect.any(String),
          },
        ],
      }),
    ]);
    for (const body of [saved.json, listed]) {
      expect(JSON.stringify(body)).not.toContain("opus-secret");
      expect(JSON.stringify(body)).not.toContain(haikuToken);
    }
  });

  test("a trigger saved with only its id is listed as waiting for its token, with a link to its routine", async () => {
    const { ada, project, runner } = await adaWithSubscriptionRunner();

    const saved = await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "opus",
      projectId: project.id,
      triggerId: "trig_01Opus",
    });

    expect(saved.triggers).toEqual([
      expect.objectContaining({ model: "haiku", triggerId: "trig_haiku", waitingForToken: false }),
      {
        id: expect.any(String),
        model: "opus",
        projectId: project.id,
        triggerId: "trig_01Opus",
        waitingForToken: true,
        routineUrl: "https://claude.ai/code/routines/trig_01Opus",
        createdAt: expect.any(String),
      },
    ]);
    expect((await ok("GET", "/api/runners", ada))[0].triggers).toEqual(saved.triggers);
  });

  test("saving a trigger again for the same model and Project replaces it", async () => {
    const { ada, runner } = await adaWithSubscriptionRunner();

    const replaced = await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "HAIKU",
      triggerId: "trig_new",
      token: "new",
    });

    expect(replaced.triggers.map((t: { model: string; triggerId: string }) => [t.model, t.triggerId])).toEqual([
      ["HAIKU", "trig_new"],
    ]);
  });

  test("saving the same trigger id again without a token keeps its token; another id waits for one", async () => {
    const { ada, ticket, runner, agent, status } = await adaWithSubscriptionRunner();

    const kept = await ok("POST", `/api/runners/${runner.id}/triggers`, ada, { model: "haiku", triggerId: "trig_haiku" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    const other = await ok("POST", `/api/runners/${runner.id}/triggers`, ada, { model: "haiku", triggerId: "trig_new" });

    expect(kept.triggers).toEqual([expect.objectContaining({ triggerId: "trig_haiku", waitingForToken: false })]);
    expect(cronk.claude.fires.map((f) => [f.triggerId, f.token])).toEqual([["trig_haiku", haikuToken]]);
    expect(other.triggers).toEqual([expect.objectContaining({ triggerId: "trig_new", waitingForToken: true })]);
  });

  test("pasting a token needs one, into a trigger the Runner has", async () => {
    const { ada, runner } = await adaWithSubscriptionRunner();
    const [trigger] = (await ok("GET", "/api/runners", ada))[0].triggers;

    const blank = await call("PUT", `/api/runners/${runner.id}/triggers/${trigger.id}/token`, ada, { token: "  " });
    const unknown = await call("PUT", `/api/runners/${runner.id}/triggers/${crypto.randomUUID()}/token`, ada, {
      token: "x",
    });
    const notAnId = await call("PUT", `/api/runners/${runner.id}/triggers/trig_haiku/token`, ada, { token: "x" });

    expect(blank.status).toBe(400);
    expect([unknown.status, notAnId.status]).toEqual([404, 404]);
    expect(unknown.json.error.message).toBe("Claude Max has no such trigger.");
  });

  test("a removed trigger is gone", async () => {
    const { ada, runner } = await adaWithSubscriptionRunner();
    const [trigger] = (await ok("GET", "/api/runners", ada))[0].triggers;

    expect((await ok("DELETE", `/api/runners/${runner.id}/triggers/${trigger.id}`, ada)).triggers).toEqual([]);
    expect((await call("DELETE", `/api/runners/${runner.id}/triggers/${trigger.id}`, ada)).status).toBe(404);
  });

  test("only the Runner's Owner sees or changes its triggers, and only for a Project they can see", async () => {
    const { workspace, ada, runner } = await adaWithSubscriptionRunner();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const beas = await ok("POST", "/api/workspaces", { cookie: bea.cookie }, { name: "Bea's Workspace" });
    const beasProject = await ok(
      "POST",
      `/api/workspaces/${beas.id}/projects`,
      { cookie: bea.cookie },
      { name: "Bea's", key: "BEA" },
    );

    const asBea = await call(
      "POST",
      `/api/runners/${runner.id}/triggers`,
      { cookie: bea.cookie },
      { model: "haiku", triggerId: "trig_x", token: "x" },
    );
    expect(asBea.status).toBe(404);
    expect(await ok("GET", "/api/runners", { cookie: bea.cookie })).toEqual([]);
    const [trigger] = (await ok("GET", "/api/runners", ada))[0].triggers;
    const pastedByBea = await call(
      "PUT",
      `/api/runners/${runner.id}/triggers/${trigger.id}/token`,
      { cookie: bea.cookie },
      { token: "sk-ant-oat01-bea" },
    );
    expect(pastedByBea.status).toBe(404);

    const outOfView = await call("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "haiku",
      projectId: beasProject.id,
      triggerId: "trig_x",
      token: "x",
    });
    expect(outOfView.status).toBe(404);
    expect(outOfView.json.error.code).toBe("project_not_found");
    expect((await ok("GET", "/api/runners", ada))[0].triggers).toHaveLength(1);
  });

  test("a Runner of another kind has no triggers", async () => {
    await setUp(cronk);
    const ada = { cookie: await signIn(cronk) };
    const fake = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });

    const refused = await call("POST", `/api/runners/${fake.id}/triggers`, ada, {
      model: "haiku",
      triggerId: "trig_x",
      token: "x",
    });

    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("runner_has_no_triggers");
    expect((await ok("GET", "/api/runners", ada))[0].triggers).toEqual([]);
  });
});

test("saving or pasting a token is refused while Cronk has no CRONK_SECRET_KEY to encrypt it with; a trigger waiting for one is not", async () => {
  await cronk.stop();
  cronk = await startCronk({ noSecretKey: true });
  await setUp(cronk);
  const ada = { cookie: await signIn(cronk) };
  const runner = await ok("POST", "/api/runners", ada, { name: "Claude Max", kind: "subscription" });

  const refused = await call("POST", `/api/runners/${runner.id}/triggers`, ada, {
    model: "haiku",
    triggerId: "trig_x",
    token: "x",
  });
  const waiting = await call("POST", `/api/runners/${runner.id}/triggers`, ada, { model: "haiku", triggerId: "trig_x" });
  const pasted = await call("PUT", `/api/runners/${runner.id}/triggers/${waiting.json.triggers[0].id}/token`, ada, {
    token: "x",
  });

  expect(refused.status).toBe(409);
  expect(refused.json.error.code).toBe("no_secret_key");
  expect(waiting.status).toBe(200);
  expect(pasted.status).toBe(409);
  expect(pasted.json.error.code).toBe("no_secret_key");
  expect((await ok("GET", "/api/runners", ada))[0].triggers).toEqual([
    expect.objectContaining({ triggerId: "trig_x", waitingForToken: true }),
  ]);
});

describe("Runs that couldn't start", () => {
  const refusedItem = async (inbox: () => Promise<{ items: { run: unknown }[] }>) =>
    (await inbox()).items.map((i) => i.run);

  test("no trigger for the Step's model: couldn't start, with the reason in the Inbox, and nothing fired", async () => {
    const { ada, ticket, agent, status, inbox } = await adaWithSubscriptionRunner();

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Implement") });

    expect(cronk.claude.fires).toEqual([]);
    expect(await refusedItem(inbox)).toEqual([
      expect.objectContaining({
        state: "refused",
        endReason:
          "Claude Max has no trigger for the model opus: its Owner adds one in the Runner's settings, for all Projects or for Cronker.",
      }),
    ]);
  });

  test("a trigger waiting for its token: couldn't start, with the reason in the Inbox, and nothing fired", async () => {
    const { ada, project, ticket, runner, agent, status, inbox } = await adaWithSubscriptionRunner();
    await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "haiku",
      projectId: project.id,
      triggerId: "trig_cronker_haiku",
    });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect(cronk.claude.fires).toEqual([]);
    expect(await refusedItem(inbox)).toEqual([
      expect.objectContaining({
        state: "refused",
        endReason:
          "Claude Max's trigger trig_cronker_haiku for haiku on Cronker is waiting for its token: its Owner generates " +
          "one for the routine in claude.ai and pastes it into the trigger on the Runner's card.",
      }),
    ]);
  });

  test("pasting the token into a waiting trigger starts the Ticket that couldn't start", async () => {
    const { ada, project, ticket, runner, agent, status, inbox } = await adaWithSubscriptionRunner();
    const saved = await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "haiku",
      projectId: project.id,
      triggerId: "trig_cronker_haiku",
    });
    const waiting = saved.triggers.find((t: { triggerId: string }) => t.triggerId === "trig_cronker_haiku");
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    cronk.claude.trigger("trig_cronker_haiku", "sk-ant-oat01-cronker-secret");

    const pasted = await call("PUT", `/api/runners/${runner.id}/triggers/${waiting.id}/token`, ada, {
      token: " sk-ant-oat01-cronker-secret ",
    });

    expect(pasted.status).toBe(200);
    expect(pasted.json.triggers).toContainEqual(
      expect.objectContaining({ id: waiting.id, triggerId: "trig_cronker_haiku", waitingForToken: false }),
    );
    expect(JSON.stringify(pasted.json)).not.toContain("cronker-secret");
    expect(JSON.stringify(await ok("GET", "/api/runners", ada))).not.toContain("cronker-secret");
    expect(cronk.claude.fires.map((f) => [f.triggerId, f.token])).toEqual([
      ["trig_cronker_haiku", "sk-ant-oat01-cronker-secret"],
    ]);
    expect((await runsOf(ticket.id, ada)).map((r: { state: string }) => r.state)).toEqual(["refused", "running"]);
    expect(await inbox()).toEqual({ count: 0, items: [] });
  });

  test("pasting into a waiting trigger restarts only the Tickets whose Runs would fire it", async () => {
    const { workspace, ada, project, ticket, runner, agent, status } = await adaWithSubscriptionRunner();
    const other = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Other", key: "OTHER" });
    const otherTriage = other.statuses.find((s: { name: string }) => s.name === "Triage").id;
    const otherTicket = await ok("POST", `/api/projects/${other.id}/tickets`, ada, { title: "Elsewhere" });
    const opusTicket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "On opus" });
    const movedOn = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Moved on" });
    const cronkerHaiku = (
      await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
        model: "haiku",
        projectId: project.id,
        triggerId: "trig_cronker_haiku",
      })
    ).triggers.find((t: { triggerId: string }) => t.triggerId === "trig_cronker_haiku");
    await ok("POST", `/api/runners/${runner.id}/triggers`, ada, { model: "haiku", triggerId: "trig_haiku_new" });
    for (const t of [ticket, movedOn]) {
      await ok("PATCH", `/api/tickets/${t.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    }
    await ok("PATCH", `/api/tickets/${otherTicket.id}`, ada, { delegateId: agent.id, statusId: otherTriage });
    await ok("PATCH", `/api/tickets/${opusTicket.id}`, ada, { delegateId: agent.id, statusId: status("Implement") });
    await ok("PATCH", `/api/tickets/${movedOn.id}`, ada, { statusId: status("Backlog") });
    const states = async () =>
      Promise.all(
        [ticket, otherTicket, opusTicket, movedOn].map(async (t) =>
          (await runsOf(t.id, ada)).map((r: { state: string }) => r.state),
        ),
      );
    expect(await states()).toEqual([["refused"], ["refused"], ["refused"], ["refused"]]);
    cronk.claude.trigger("trig_cronker_haiku", "sk-ant-oat01-cronker");

    await ok("PUT", `/api/runners/${runner.id}/triggers/${cronkerHaiku.id}/token`, ada, { token: "sk-ant-oat01-cronker" });

    expect(await states()).toEqual([["refused", "running"], ["refused"], ["refused"], ["refused"]]);

    // Only pasting into a waiting trigger restarts Tickets: saving a trigger with its token, or pasting over a working
    // token, leaves them to Retry.
    const allProjects = (await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "HAIKU",
      triggerId: "trig_haiku",
      token: haikuToken,
    })).triggers.find((t: { projectId: string | null }) => t.projectId === null);
    await ok("PUT", `/api/runners/${runner.id}/triggers/${allProjects.id}/token`, ada, { token: haikuToken });

    expect(await states()).toEqual([["refused", "running"], ["refused"], ["refused"], ["refused"]]);
    expect(cronk.claude.fires.map((f) => f.triggerId)).toEqual(["trig_cronker_haiku"]);
  });

  test("a token claude.ai rejects: couldn't start, with the reason in the Inbox", async () => {
    const { ada, ticket, runner, agent, status, inbox } = await adaWithSubscriptionRunner();
    await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "haiku",
      triggerId: "trig_haiku",
      token: "sk-ant-oat01-revoked",
    });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect(cronk.claude.fires.map((f) => f.token)).toEqual(["sk-ant-oat01-revoked"]);
    expect(await refusedItem(inbox)).toEqual([
      expect.objectContaining({
        state: "refused",
        endReason:
          "claude.ai rejected the token of the trigger trig_haiku for haiku on Claude Max: its Owner generates a new token in claude.ai and saves it here.",
      }),
    ]);
  });

  test("a trigger claude.ai doesn't know: couldn't start, with the reason in the Inbox", async () => {
    const { ada, ticket, runner, agent, status, inbox } = await adaWithSubscriptionRunner();
    await ok("POST", `/api/runners/${runner.id}/triggers`, ada, {
      model: "haiku",
      triggerId: "trig_gone",
      token: haikuToken,
    });

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect(await refusedItem(inbox)).toEqual([
      expect.objectContaining({
        state: "refused",
        endReason:
          "claude.ai has no scheduled task for the trigger trig_gone for haiku on Claude Max: its Owner checks the trigger id, or saves a new trigger.",
      }),
    ]);
  });
});

describe("rate limits", () => {
  test("a 429 keeps the Ticket waiting and pauses the Runner's queue until Retry-After, then it resumes", async () => {
    const { ada, project, ticket, agent, status, inbox } = await adaWithSubscriptionRunner();
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    cronk.claude.rateLimitNext("120");

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    await ok("PATCH", `/api/tickets/${second.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect(cronk.claude.fires).toHaveLength(1);
    expect((await ok("GET", "/api/runners", ada))[0].pausedUntil).toBe("2026-01-01T09:02:00.000Z");
    for (const t of [ticket, second]) {
      expect(await ok("GET", `/api/tickets/${t.id}`, ada)).toEqual(
        expect.objectContaining({ lastRun: null, waiting: "runnerPaused" }),
      );
    }
    expect(await inbox()).toEqual({ count: 0, items: [] });

    cronk.clock.advance(119_000);
    await cronk.resumePausedRunners();
    expect(cronk.claude.fires).toHaveLength(1);

    cronk.clock.advance(1_000);
    await cronk.resumePausedRunners();

    expect(cronk.claude.fires).toHaveLength(3);
    expect((await runsOf(ticket.id, ada)).map((r: { state: string }) => r.state)).toEqual(["running"]);
    expect((await runsOf(second.id, ada)).map((r: { state: string }) => r.state)).toEqual(["running"]);
    expect((await ok("GET", "/api/runners", ada))[0].pausedUntil).toBeNull();
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).waiting).toBeNull();
  });

  test.each([
    ["no Retry-After", undefined, "2026-01-01T09:01:00.000Z"],
    ["one that is neither seconds nor a date", "soon", "2026-01-01T09:01:00.000Z"],
    ["a fraction", "1.5", "2026-01-01T09:01:00.000Z"],
    ["a date already passed", "Thu, 01 Jan 2026 08:00:00 GMT", "2026-01-01T09:00:00.000Z"],
    ["one beyond a day", "99999999999999", "2026-01-02T09:00:00.000Z"],
  ])("a 429 with %s pauses the queue for a minute, not at all, or a day at most", async (_, retryAfter, until) => {
    const { ada, ticket, agent, status } = await adaWithSubscriptionRunner();
    cronk.claude.rateLimitNext(retryAfter);

    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });

    expect((await ok("GET", "/api/runners", ada))[0].pausedUntil).toBe(until);
    expect((await ok("GET", `/api/tickets/${ticket.id}`, ada)).waiting).toBe("runnerPaused");
  });

  test("a Run of the Runner ending while it is paused starts no waiting Ticket", async () => {
    const { ada, project, ticket, agent, agentToken, status } = await adaWithSubscriptionRunner();
    const second = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title: "Second" });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    cronk.claude.rateLimitNext("Thu, 01 Jan 2026 10:00:00 GMT");
    await ok("PATCH", `/api/tickets/${second.id}`, ada, { delegateId: agent.id, statusId: status("Triage") });
    expect((await ok("GET", "/api/runners", ada))[0].pausedUntil).toBe("2026-01-01T10:00:00.000Z");

    const [run] = await runsOf(ticket.id, ada);
    await ok(
      "POST",
      `/api/runs/${run.id}/finish`,
      { headers: { authorization: `Bearer ${agentToken}` } },
      { outcome: "ready" },
    );

    expect(cronk.claude.fires).toHaveLength(2);
    expect((await ok("GET", `/api/tickets/${second.id}`, ada)).waiting).toBe("runnerPaused");

    cronk.clock.advance(60 * 60 * 1000);
    await cronk.resumePausedRunners();
    expect(cronk.claude.fires).toHaveLength(3);
    expect((await runsOf(second.id, ada)).map((r: { state: string }) => r.state)).toEqual(["running"]);
  });
});

describe("whose Runner", () => {
  test("a Run fires only the delegating User's own Runner's trigger; nobody delegates to, or points an Agent at, another's", async () => {
    const {
      workspace,
      ada,
      project,
      ticket,
      runner: adasRunner,
      agent: adasAgent,
      status,
    } = await adaWithSubscriptionRunner();
    const bea = await addMember(cronk, ada.cookie, workspace.id, "bea@example.com");
    const asBea = { cookie: bea.cookie };
    const beasRunner = await ok("POST", "/api/runners", asBea, { name: "Bea's Max", kind: "subscription" });
    cronk.claude.trigger("trig_bea_haiku", "sk-ant-oat01-bea");
    await ok("POST", `/api/runners/${beasRunner.id}/triggers`, asBea, {
      model: "haiku",
      triggerId: "trig_bea_haiku",
      token: "sk-ant-oat01-bea",
    });
    const beasAgent = await ok("POST", `/api/workspaces/${workspace.id}/agents`, asBea, { name: "bea-claude" });

    const pointedAtAdas = await call("PATCH", `/api/agents/${beasAgent.id}`, asBea, { runnerId: adasRunner.id });
    expect(pointedAtAdas.json.error.code).toBe("unknown_runner");
    await ok("PATCH", `/api/agents/${beasAgent.id}`, asBea, { runnerId: beasRunner.id });
    const delegatedToBeas = await call("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: beasAgent.id });
    expect(delegatedToBeas.json.error.code).toBe("not_your_agent");

    const beasTicket = await ok("POST", `/api/projects/${project.id}/tickets`, asBea, { title: "Bea's work" });
    await ok("PATCH", `/api/tickets/${beasTicket.id}`, asBea, { delegateId: beasAgent.id, statusId: status("Triage") });
    await ok("PATCH", `/api/tickets/${ticket.id}`, ada, { delegateId: adasAgent.id, statusId: status("Triage") });

    expect(cronk.claude.fires.map((f) => [f.triggerId, f.token])).toEqual([
      ["trig_bea_haiku", "sk-ant-oat01-bea"],
      ["trig_haiku", haikuToken],
    ]);
  });
});
