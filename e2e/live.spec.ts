import { connect, type Socket } from "node:net";
import { addMember, setUp, signIn } from "../test/harness/flows.js";
import { startCronk, type StartedCronk } from "../test/harness/start-cronk.js";
import { expect, fieldPicker, signInInBrowser, test, webRoot } from "./fixtures.js";

test("the board and the Ticket view show what another member changes, without a reload", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
    cookie,
    body: { name: "Cronker", key: "CRONK" },
  });
  const project = (await created.json()) as { id: string; statuses: { id: string; name: string }[] };
  const statusId = (name: string) => project.statuses.find((s) => s.name === name)!.id;
  const bob = await addMember(cronk, cookie, workspace.id, "bob@example.com");
  const asBob = (method: string, path: string, body?: unknown) =>
    cronk.request(method, path, { cookie: bob.cookie, body }).then((response) => {
      expect(response.ok).toBe(true);
      return response.json();
    });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill("ada@example.com");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const board = page.getByRole("region", { name: "Board" });
  const lane = (name: string) => board.getByRole("region", { name, exact: true });
  await expect(lane("Backlog")).toBeVisible();

  const ticket = await asBob("POST", `/api/projects/${project.id}/tickets`, { title: "Filed by Bob" });
  await expect(lane("Backlog").getByRole("link", { name: /CRONK-1 Filed by Bob/ })).toBeVisible();
  await asBob("PATCH", `/api/tickets/${ticket.id}`, { statusId: statusId("Ready"), title: "Moved by Bob" });
  await expect(lane("Ready").getByRole("link", { name: /CRONK-1 Moved by Bob/ })).toBeVisible();
  await expect(lane("Backlog").getByRole("link")).toHaveCount(0);
  await asBob("POST", `/api/projects/${project.id}/statuses`, { name: "Waiting", kind: "backlog" });
  await expect(lane("Waiting")).toBeVisible();

  await lane("Ready").getByRole("link", { name: /CRONK-1/ }).click();
  await expect(page.getByRole("heading", { name: "CRONK-1 Moved by Bob" })).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByRole("textbox", { name: "Description" }).fill("Ada is still typing");
  await asBob("PATCH", `/api/tickets/${ticket.id}`, { priority: "high", statusId: statusId("Triage") });
  await expect(fieldPicker(page, "Priority")).toContainText("High");
  await expect(fieldPicker(page, "Status")).toContainText("Triage");
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText(
    "bob@example.com changed Priority from None to High",
  );
  await expect(page.getByRole("textbox", { name: "Description" })).toHaveText("Ada is still typing");
  await asBob("POST", `/api/tickets/${ticket.id}/comments`, { body: "Picking this up." });
  await expect(page.getByRole("region", { name: "Timeline" }).getByRole("article", { name: "Comment by bob@example.com" })).toContainText(
    "Picking this up.",
  );
});

test("a slow answer about a Ticket never replaces a newer one on its page", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = (await created.json()) as { id: string };
  const bob = await addMember(cronk, cookie, workspace.id, "bob@example.com");
  const asBob = (method: string, path: string, body?: unknown) =>
    cronk.request(method, path, { cookie: bob.cookie, body }).then((response) => {
      expect(response.ok).toBe(true);
      return response.json();
    });
  const ticket = await asBob("POST", `/api/projects/${project.id}/tickets`, { title: "Filed" });

  // Once the page shows, the next load, after Bob's first change, answers only after his second has shown.
  let armed = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  await page.route(`**/api/tickets/${ticket.id}`, async (route) => {
    if (route.request().method() !== "GET" || !armed) return route.fallback();
    armed = false;
    const response = await route.fetch();
    held();
    await released;
    await route.fulfill({ response });
  });
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  await expect(page.getByRole("heading", { name: "CRONK-1 Filed" })).toBeVisible();
  armed = true;

  await asBob("PATCH", `/api/tickets/${ticket.id}`, { title: "Renamed once" });
  await holding;
  await asBob("PATCH", `/api/tickets/${ticket.id}`, { title: "Renamed twice" });
  await expect(page.getByRole("heading", { name: "CRONK-1 Renamed twice" })).toBeVisible();
  release();
  await page.waitForTimeout(500);
  await expect(page.getByRole("heading", { name: "CRONK-1 Renamed twice" })).toBeVisible();
});

test("every streaming view says it is Live, and Reconnecting… while its stream is away", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } });
  const project = (await created.json()) as { id: string };
  const ticket = await (await cronk.request("POST", `/api/projects/${project.id}/tickets`, { cookie, body: { title: "Live" } })).json();

  await signInInBrowser(page, cronk);
  const live = page.getByRole("status", { name: "Live updates" });
  for (const path of [
    `/projects/${project.id}`,
    `/workspaces/${workspace.id}/inbox`,
    `/workspaces/${workspace.id}/documents`,
    `/workspaces/${workspace.id}/glossary`,
    `/workspaces/${workspace.id}/decisions`,
    `/tickets/${ticket.id}`,
  ]) {
    await page.goto(`${cronk.url}${path}`);
    await expect(live, path).toHaveText("Live");
  }

  // The stream drops, here by Cronk ending it as the browser's sign-in ends, and can't reach Cronk again for now.
  await page.route("**/events", (route) => route.abort());
  const browserCookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
  expect((await cronk.request("DELETE", "/api/sign-in", { cookie: browserCookie })).status).toBe(204);
  await expect(live).toHaveText("Reconnecting…");
  // What changes while it is away shows once it is back.
  expect((await cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body: { title: "Renamed while away" } })).ok).toBe(true);

  // Once Cronk can be reached again, with a sign-in, the stream comes back.
  await page.context().addCookies([{ name: cookie.split("=")[0]!, value: cookie.split("=").slice(1).join("="), url: cronk.url }]);
  await page.unroute("**/events");
  await expect(live).toHaveText("Live", { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "CRONK-1 Renamed while away" })).toBeVisible();
});

/** Opens a connection to Cronk without sending anything on it yet. */
function connectTo(cronk: StartedCronk): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(Number(new URL(cronk.url).port), "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });
}

/** Whether stopping finishes within 5s; without the fix it waits on a timeout of a minute or more. */
function stopsAtOnce(stopping: Promise<void>): Promise<string> {
  return Promise.race([
    stopping.then(() => "stopped"),
    new Promise<string>((resolve) => setTimeout(resolve, 5_000, "still stopping after 5s")),
  ]);
}

// These two start Cronk themselves rather than through the fixture, so they can time stopping it.

test("Cronk stops at once while the browser holds a connection it has not used yet", async ({ page }) => {
  const cronk = await startCronk({ webRoot });
  let spare: Socket;
  try {
    await setUp(cronk);
    const stream = page.waitForResponse((response) => response.url().endsWith("/events"));
    await page.goto(cronk.url);
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in" }).click();
    await stream;
    // Browsers open connections ahead of need, such as one to reconnect the event stream on.
    spare = await connectTo(cronk);
  } catch (error) {
    await cronk.stop();
    throw error;
  }

  const stopped = await stopsAtOnce(cronk.stop());
  spare.destroy();
  expect(stopped).toBe("stopped");
});

test("Cronk stops at once after answering a request that was in flight when it began to stop", async () => {
  const cronk = await startCronk({ webRoot });
  // No one has set Cronk up, so the sign-in is refused: what matters is that it is answered.
  const body = JSON.stringify({ email: "ada@example.com", password: "correct horse battery" });
  let socket: Socket;
  try {
    // A request whose body has yet to arrive, as a slow upload's, keeps its connection busy.
    socket = await connectTo(cronk);
    socket.write(
      `POST /api/sign-in HTTP/1.1\r\nhost: ${new URL(cronk.url).host}\r\ncontent-type: application/json\r\n` +
        `content-length: ${body.length}\r\n\r\n${body.slice(0, 5)}`,
    );
    await expect.poll(() => cronk.logs.some((line) => line.msg === "incoming request")).toBe(true);
  } catch (error) {
    await cronk.stop();
    throw error;
  }

  const stopping = cronk.stop();
  // Once Cronk is stopping, it takes no new connections.
  await expect
    .poll(() => connectTo(cronk).then((s) => new Promise((resolve) => s.once("close", () => resolve("refused"))), () => "refused"))
    .toBe("refused");
  const answered = new Promise<string>((resolve) => socket.once("data", (data) => resolve(String(data))));
  socket.write(body.slice(5));
  expect(await answered).toMatch(/^HTTP\/1\.1 401 /);
  const stopped = await stopsAtOnce(stopping);
  socket.destroy();
  expect(stopped).toBe("stopped");
});
