import { firstUser, setUp, signIn } from "../test/harness/flows.js";
import { expect, test } from "./fixtures.js";

test("the register filters by status and points a superseded Decision at its replacement, whose page and the replaced one's say so", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const record = async (title: string, status?: string) =>
    (await (await cronk.request("POST", `/api/workspaces/${workspace.id}/decisions`, { cookie, body: { title, status } })).json()) as { id: string };
  await record("Use Postgres for everything", "accepted");
  const replaced = await record("Runs start from a Brief");
  const replacing = await record("Runs start from a Brief and the Ticket", "accepted");
  await cronk.request("PATCH", `/api/decisions/${replaced.id}`, { cookie, body: { baseVersion: 1, status: "superseded", supersededById: replacing.id } });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(firstUser.email);
  await page.getByLabel("Password").fill(firstUser.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation", { name: "Sidebar" }).getByRole("link", { name: "Decisions" }).click();

  const filters = page.getByRole("group", { name: "Filter by status" });
  await expect(filters.getByRole("button")).toHaveText(["All 3", "Proposed 0", "Accepted 2", "Rejected 0", "Deprecated 0", "Superseded 1"]);
  const register = page.getByRole("region", { name: "Decisions" });
  await expect(register.getByRole("row", { name: /0002/ })).toContainText("Runs start from a Brief → 0003");
  await filters.getByRole("button", { name: "Superseded 1" }).click();
  await expect(register.getByRole("row")).toHaveCount(2);

  await register.getByRole("link", { name: "Runs start from a Brief", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runs start from a Brief", level: 1 })).toBeVisible();
  await expect(page.getByRole("note", { name: "Superseded" })).toContainText("Superseded by 0003 Runs start from a Brief and the Ticket.");
  const details = page.getByRole("complementary", { name: "Decision details" });
  await expect(details).toContainText("Proposed by");
  await expect(details).toContainText(firstUser.email);
  await expect(details.getByLabel("Change status")).toHaveValue("superseded");
  await expect(details.getByLabel("Replaced by")).toHaveValue(replacing.id);

  await page.getByRole("note", { name: "Superseded" }).getByRole("link").click();
  await expect(page.getByRole("heading", { name: "Runs start from a Brief and the Ticket", level: 1 })).toBeVisible();
  await expect(page.getByRole("note", { name: "Supersedes" })).toContainText("Supersedes 0002 Runs start from a Brief.");
});
