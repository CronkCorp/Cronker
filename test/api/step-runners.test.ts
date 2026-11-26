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

async function call(method: string, path: string, cookie: string, body?: unknown) {
  const response = await cronk.request(method, path, { cookie, body });
  return { status: response.status, json: response.status === 204 ? null : await response.json() };
}

async function ok(method: string, path: string, cookie: string, body?: unknown) {
  const response = await call(method, path, cookie, body);
  expect(response.status, `${method} ${path}: ${JSON.stringify(response.json)}`).toBeLessThan(300);
  return response.json;
}

interface Status {
  id: string;
  name: string;
  step: { runner: string | null } | null;
}

/**
 * Ada with a Project on the default board, her Agent `claude-max` using her fake Runner `Fake`, and a second fake
 * Runner `Desktop` no Agent uses.
 */
async function adaWithTwoRunners() {
  const { workspace } = await setUp(cronk);
  const ada = await signIn(cronk);
  const project = await ok("POST", `/api/workspaces/${workspace.id}/projects`, ada, { name: "Cronker", key: "CRONK" });
  const fake = await ok("POST", "/api/runners", ada, { name: "Fake", kind: "fake" });
  const desktop = await ok("POST", "/api/runners", ada, { name: "Desktop", kind: "fake" });
  const created = await ok("POST", `/api/workspaces/${workspace.id}/agents`, ada, { name: "claude-max" });
  const agent = await ok("PATCH", `/api/agents/${created.id}`, ada, { runnerId: fake.id });
  const statusNamed = (name: string) => (project.statuses as Status[]).find((s) => s.name === name)!;
  /** Sets the Runner the Step on the Status names, keeping the rest of the Step; returns the Project. */
  const setStepRunner = async (name: string, runner: string | null) => {
    const status = statusNamed(name);
    const { step } = (await ok("GET", `/api/projects/${project.id}`, ada)).statuses.find((s: Status) => s.id === status.id);
    return ok("PUT", `/api/projects/${project.id}/statuses/${status.id}/step`, ada, { ...step, runner });
  };
  /** Creates a Ticket, delegates it to claude-max and moves it to Triage, a second later than the last. */
  const triaged = async (title: string, labels: string[] = []) => {
    cronk.clock.advance(1000);
    const ticket = await ok("POST", `/api/projects/${project.id}/tickets`, ada, { title });
    return ok("PATCH", `/api/tickets/${ticket.id}`, ada, { labels, delegateId: agent.id, statusId: statusNamed("Triage").id });
  };
  const runsOf = (ticketId: string) => ok("GET", `/api/tickets/${ticketId}/runs`, ada);
  const waitingOf = async (ticketId: string) => (await ok("GET", `/api/tickets/${ticketId}`, ada)).waiting;
  const startedOn = () => cronk.runner.starts.map((s) => `${s.ticket.key} on ${s.runner.name}`);
  return { ada, project, fake, desktop, agent, setStepRunner, triaged, runsOf, waitingOf, startedOn };
}

describe("a Step's Runner", () => {
  test("is none on the default board, and a Step set to one keeps it, trimmed", async () => {
    const { setStepRunner, project, ada } = await adaWithTwoRunners();
    expect((project.statuses as Status[]).filter((s) => s.step).map((s) => s.step!.runner)).toEqual(
      (project.statuses as Status[]).filter((s) => s.step).map(() => null),
    );

    const saved = await setStepRunner("Triage", "  Desktop ");

    expect(saved.statuses.find((s: Status) => s.name === "Triage").step.runner).toBe("Desktop");
    const read = await ok("GET", `/api/projects/${project.id}`, ada);
    expect(read.statuses.find((s: Status) => s.name === "Triage").step.runner).toBe("Desktop");
  });

  test("starts the Step's Runs on the Delegate's Owner's Runner of that name, ignoring case", async () => {
    const { setStepRunner, triaged, runsOf, startedOn } = await adaWithTwoRunners();
    await setStepRunner("Triage", "desktop");

    const ticket = await triaged("On the desktop");

    expect(startedOn()).toEqual(["CRONK-1 on Desktop"]);
    expect((await runsOf(ticket.id))[0].state).toBe("running");
  });

  test("a Step naming none starts its Runs on the Delegate's own Runner, as before", async () => {
    const { setStepRunner, triaged, startedOn } = await adaWithTwoRunners();
    await setStepRunner("Triage", "Desktop");
    await triaged("On the desktop");

    await setStepRunner("Triage", null);
    await triaged("On the Agent's Runner");

    expect(startedOn()).toEqual(["CRONK-1 on Desktop", "CRONK-2 on Fake"]);
  });

  test("a Ticket waits for the named Runner's slot and isn't moved to another Runner with room", async () => {
    const { ada, desktop, setStepRunner, triaged, runsOf, waitingOf, startedOn } = await adaWithTwoRunners();
    await ok("PATCH", `/api/runners/${desktop.id}`, ada, { limit: 1 });
    await setStepRunner("Triage", "Desktop");

    const first = await triaged("First");
    const second = await triaged("Second");

    expect(startedOn()).toEqual(["CRONK-1 on Desktop"]);
    expect(await waitingOf(second.id)).toBe("runnerSlot");

    // Its slot freeing gives it to the Ticket waiting in its own queue.
    const [run] = await runsOf(first.id);
    await cronk.runner.endWithoutFinishing(run.id);

    expect(startedOn()).toEqual(["CRONK-1 on Desktop", "CRONK-2 on Desktop"]);
    expect(await waitingOf(second.id)).toBeNull();
  });

  test("a Ticket waiting in the Agent's Runner's queue moves to the named Runner's once its Step names it", async () => {
    const { ada, fake, setStepRunner, triaged, waitingOf, startedOn } = await adaWithTwoRunners();
    await ok("PATCH", `/api/runners/${fake.id}`, ada, { limit: 1 });
    await triaged("First");
    const second = await triaged("Second");
    expect(await waitingOf(second.id)).toBe("runnerSlot");

    await setStepRunner("Triage", "Desktop");

    expect(startedOn()).toEqual(["CRONK-1 on Fake", "CRONK-2 on Desktop"]);
  });

  test("whose name the Delegate's Owner has no Runner of gets a refused Run, not one on another Runner", async () => {
    const { setStepRunner, triaged, runsOf, startedOn } = await adaWithTwoRunners();
    await setStepRunner("Triage", "Laptop");

    const ticket = await triaged("Nowhere to run");

    const [run] = await runsOf(ticket.id);
    expect(run).toEqual(
      expect.objectContaining({
        state: "refused",
        endReason: expect.stringContaining("Triage starts its Runs on the Runner Laptop, and claude-max's Owner has no Runner of that name."),
      }),
    );
    expect(startedOn()).toEqual([]);
  });

  test("a local Runner with no Machine connected leaves the Ticket waiting offline, not on the Agent's Runner", async () => {
    const { ada, setStepRunner, triaged, runsOf, waitingOf, startedOn } = await adaWithTwoRunners();
    await ok("POST", "/api/runners", ada, { name: "Laptop", kind: "local" });
    await setStepRunner("Triage", "Laptop");

    // A local-only Ticket may go to it: a local Runner isn't a cloud one.
    const ticket = await triaged("Touch the laptop", ["local-only"]);

    expect(await waitingOf(ticket.id)).toBe("runnerOffline");
    expect(await runsOf(ticket.id)).toEqual([]);
    expect(startedOn()).toEqual([]);
  });

  test("a cloud Runner refuses a local-only Ticket's Run, naming the Step", async () => {
    const { ada, setStepRunner, triaged, runsOf, startedOn } = await adaWithTwoRunners();
    await ok("POST", "/api/runners", ada, { name: "Max", kind: "subscription" });
    await setStepRunner("Triage", "Max");

    const ticket = await triaged("Touch the laptop", ["local-only"]);

    const [run] = await runsOf(ticket.id);
    expect(run).toEqual(
      expect.objectContaining({
        state: "refused",
        endReason: expect.stringContaining(
          "CRONK-1 is labelled local-only: it can't run in a cloud session, and Triage uses Max, a cloud Runner.",
        ),
      }),
    );
    expect(startedOn()).toEqual([]);
  });
});
