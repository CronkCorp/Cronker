import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

test("a Ticket key in a Document links to its Ticket, which lists the Document under Mentioned in", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } })
  ).json();
  await cronk.request("POST", `/api/projects/${project.id}/tickets`, { cookie, body: { title: "Sign in with GitHub" } });
  const document = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/documents`, {
      cookie,
      body: { title: "Roadmap", body: "First cronk-1, then the rest; `CRONK-1` in code stays as written." },
    })
  ).json();

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/documents/${document.id}`);
  const body = page.getByRole("article", { name: "Roadmap" });
  await expect(body.getByRole("link", { name: "cronk-1" })).toBeVisible();
  // The key in code is no link.
  await expect(body.getByRole("link")).toHaveCount(1);

  await body.getByRole("link", { name: "cronk-1" }).click();

  await expect(page).toHaveURL(/\/tickets\/CRONK-1$/);
  await expect(page.getByRole("heading", { name: "Sign in with GitHub" })).toBeVisible();
  const mentionedIn = page.getByRole("region", { name: "Mentioned in" });
  await expect(mentionedIn.getByRole("listitem")).toHaveText(["Document Roadmap"]);
  await mentionedIn.getByRole("link", { name: "Roadmap" }).click();
  await expect(page.getByRole("article", { name: "Roadmap" })).toBeVisible();
});

test("Decision keys in a Document link to their Decisions, which list the Document under Mentioned in", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const project = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/projects`, { cookie, body: { name: "Cronker", key: "CRONK" } })
  ).json();
  await cronk.request("POST", `/api/workspaces/${workspace.id}/decisions`, { cookie, body: { title: "Write it down", body: "" } });
  await cronk.request("POST", `/api/projects/${project.id}/decisions`, { cookie, body: { title: "Use Postgres", body: "" } });
  const document = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/documents`, {
      cookie,
      body: { title: "Roadmap", body: "Per CRONK-D1, which follows d1." },
    })
  ).json();

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/documents/${document.id}`);
  const body = page.getByRole("article", { name: "Roadmap" });
  // `D1` doesn't link again inside `CRONK-D1`.
  await expect(body.getByRole("link")).toHaveText(["CRONK-D1", "d1"]);

  await body.getByRole("link", { name: "CRONK-D1", exact: true }).click();
  await expect(page).toHaveURL(/\/projects\/CRONK\/decisions\/1$/);
  await expect(page.getByRole("heading", { name: "Use Postgres" })).toBeVisible();
  const mentionedIn = page.getByRole("region", { name: "Mentioned in" });
  await expect(mentionedIn.getByRole("listitem")).toHaveText(["Document Roadmap"]);

  await page.goBack();
  await page.getByRole("article", { name: "Roadmap" }).getByRole("link", { name: "d1", exact: true }).click();
  await expect(page).toHaveURL(/\/decisions\/1$/);
  await expect(page).not.toHaveURL(/\/projects\//);
  await expect(page.getByRole("heading", { name: "Write it down" })).toBeVisible();
});
