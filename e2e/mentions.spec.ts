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

test("a Term's name in a Document links to its glossary entry, which lists the Document under Mentioned in", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  await cronk.request("POST", `/api/workspaces/${workspace.id}/terms`, { cookie, body: { name: "Run", definition: "One go." } });
  await cronk.request("POST", `/api/workspaces/${workspace.id}/terms`, { cookie, body: { name: "Run Step", definition: "Where a Run starts." } });
  const document = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/documents`, {
      cookie,
      body: { title: "Roadmap", body: "Each Run Step starts a Run; a run or a Runner is no Term." },
    })
  ).json();

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/documents/${document.id}`);
  const body = page.getByRole("article", { name: "Roadmap" });
  // The longest name wins, and only the name with its capitalisation, as a whole word, is a link.
  await expect(body.getByRole("link")).toHaveText(["Run Step", "Run"]);

  await body.getByRole("link", { name: "Run", exact: true }).click();

  await expect(page).toHaveURL(/\/glossary\/Run$/);
  const mentionedIn = page.getByRole("region", { name: "Mentioned in" });
  await expect(mentionedIn.getByRole("listitem")).toHaveText(["Document Roadmap", "Term Run Step"]);
});
