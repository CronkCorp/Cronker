import { addMember, setUp, signIn } from "../test/harness/flows.js";
import { expect, test } from "./fixtures.js";

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
