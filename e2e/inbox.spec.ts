import { expect, test } from "./fixtures.js";

test("the Inbox lists Tickets waiting for review, and it and its count update live", async ({ page, cronk }) => {
  const credentials = { email: "ada@example.com", password: "correct horse battery" };
  const setup = await cronk.request("POST", "/api/setup", {
    body: { ...credentials, setupCode: cronk.setupCode(), workspaceName: "Ada's Workspace" },
  });
  const { user, workspace } = await setup.json();
  const signedIn = await cronk.request("POST", "/api/sign-in", { body: credentials });
  const cookie = signedIn.headers.get("set-cookie")!.split(";")[0]!;
  const project = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, {
      cookie,
      body: { name: "Cronker", key: "CRONK" },
    })
  ).json();
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id;
  const ticket = await (
    await cronk.request("POST", `/api/projects/${project.id}/tickets`, { cookie, body: { title: "Review me" } })
  ).json();
  const edit = (body: object) => cronk.request("PATCH", `/api/tickets/${ticket.id}`, { cookie, body });

  await page.goto(cronk.url);
  await page.getByLabel("Email").fill(credentials.email);
  await page.getByLabel("Password").fill(credentials.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  const inboxLink = page.getByRole("navigation").getByRole("link", { name: /^Inbox/ });
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");

  await edit({ statusId: status("In Review"), assigneeId: user.id });
  await expect(inboxLink).toHaveAccessibleName("Inbox, 1 waiting");

  await inboxLink.click();
  await expect(page.getByRole("heading", { name: "Inbox" })).toBeVisible();
  const items = page.getByRole("list", { name: "Inbox" }).getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText("Waiting for your review in In Review");
  await expect(items.first().getByRole("link", { name: "CRONK-1 Review me" })).toBeVisible();

  await edit({ title: "Review me now" });
  await expect(items.first().getByRole("link", { name: "CRONK-1 Review me now" })).toBeVisible();

  await edit({ statusId: status("Done") });
  await expect(items).toHaveCount(0);
  await expect(page.getByText("Nothing is waiting on you.")).toBeVisible();
  await expect(inboxLink).toHaveAccessibleName("Inbox, nothing waiting");
});
