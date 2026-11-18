import { connect, type Socket } from "node:net";
import { addMember, setUp, signIn } from "../test/harness/flows.js";
import { startCronk } from "../test/harness/start-cronk.js";
import { expect, test, webRoot } from "./fixtures.js";

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
  await page.getByRole("link", { name: "Cronker" }).click();
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
  await page.getByLabel("Edit description").fill("Ada is still typing");
  await asBob("PATCH", `/api/tickets/${ticket.id}`, { priority: "high", statusId: statusId("Triage") });
  await expect(page.getByLabel("Priority")).toHaveValue("high");
  await expect(page.getByLabel("Status")).toHaveValue(statusId("Triage"));
  await expect(page.getByRole("region", { name: "Timeline" })).toContainText(
    "bob@example.com changed Priority from None to High",
  );
  await expect(page.getByLabel("Edit description")).toHaveValue("Ada is still typing");
  await asBob("POST", `/api/tickets/${ticket.id}/comments`, { body: "Picking this up." });
  await expect(page.getByRole("region", { name: "Comments" }).getByRole("article")).toContainText(["Picking this up."]);
});

test("Cronk stops at once while the browser holds a connection it has not used yet", async ({ page }) => {
  // Started here rather than by the fixture, so the test can time stopping it.
  const cronk = await startCronk({ webRoot });
  let spare: Socket | undefined;
  try {
    await setUp(cronk);
    const stream = page.waitForResponse((response) => response.url().endsWith("/events"));
    await page.goto(cronk.url);
    await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Password").fill("correct horse battery");
    await page.getByRole("button", { name: "Sign in" }).click();
    await stream;
    // Browsers open connections ahead of need, such as one to reconnect the event stream on.
    const { port } = new URL(cronk.url);
    spare = await new Promise<Socket>((resolve, reject) => {
      const socket = connect(Number(port), "127.0.0.1", () => resolve(socket)).once("error", reject);
    });
  } catch (error) {
    await cronk.stop();
    throw error;
  }

  const stopped = await Promise.race([
    cronk.stop().then(() => "stopped"),
    new Promise((resolve) => setTimeout(resolve, 5_000, "still stopping after 5s")),
  ]);
  spare.destroy();
  expect(stopped).toBe("stopped");
});

test("Cronk stops at once after answering a request that was in flight when it began to stop", async () => {
  const cronk = await startCronk({ webRoot });
  const { port } = new URL(cronk.url);
  const body = JSON.stringify({ email: "ada@example.com", password: "correct horse battery" });
  let socket: Socket;
  try {
    // A request whose body has yet to arrive, as a slow upload's, keeps its connection busy.
    socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(Number(port), "127.0.0.1", () => resolve(s)).once("error", reject);
    });
    socket.write(
      `POST /api/sign-in HTTP/1.1\r\nhost: 127.0.0.1:${port}\r\ncontent-type: application/json\r\n` +
        `content-length: ${body.length}\r\n\r\n${body.slice(0, 5)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  } catch (error) {
    await cronk.stop();
    throw error;
  }

  const stopping = cronk.stop().then(() => "stopped");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const answered = new Promise<string>((resolve) => socket.once("data", (data) => resolve(String(data))));
  socket.write(body.slice(5));
  expect(await answered).toMatch(/^HTTP\/1\.1 401 /);
  const stopped = await Promise.race([
    stopping,
    new Promise((resolve) => setTimeout(resolve, 5_000, "still stopping after 5s")),
  ]);
  socket.destroy();
  expect(stopped).toBe("stopped");
});
