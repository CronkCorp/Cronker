import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

// Mentions in the editor (CRONK-23, docs/ui.md, Rich editor): the draft's Mentions show as links while editing, and
// typing a Project's key opens the Mention picker, whose pick goes in as the plain key and saves as such.

test("a Ticket key shows as a link while editing, and a Ticket picked from the picker saves as its plain key", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  await post(`/api/projects/${project.id}/tickets`, { title: "Use Postgres" });
  await post(`/api/projects/${project.id}/tickets`, { title: "Ship the editor" });
  await post(`/api/projects/${project.id}/terms`, { name: "Lane", definition: "A column." });
  const document = await post(`/api/projects/${project.id}/documents`, { title: "Plan", body: "Follows CRONK-1 on a Lane.\n" });
  const saved = async () => (await (await cronk.request("GET", `/api/documents/${document.id}`, { cookie })).json()).body as string;

  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/documents/${document.id}`);
  await page.getByRole("button", { name: "Edit" }).click();
  const text = page.getByRole("textbox", { name: "Body" });

  // Each Mention links as the reader will see it.
  await expect(text.getByRole("link", { name: "CRONK-1" })).toHaveAttribute("href", /\/tickets\/CRONK-1$/);
  await expect(text.getByRole("link", { name: "Lane" })).toBeVisible();

  await text.getByText("Follows").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Then CRONK-");
  const picker = page.getByRole("listbox", { name: "Mention" });
  await expect(picker.getByRole("option")).toHaveText([/CRONK-2\s*Ship the editor/, /CRONK-1\s*Use Postgres/]);
  await expect(text).toHaveAttribute("aria-activedescendant", /.+/);
  await page.keyboard.type("2");
  await expect(picker.getByRole("option")).toHaveText([/CRONK-2/]);
  await page.keyboard.press("Enter");
  await expect(picker).toBeHidden();
  await expect(text.getByRole("link", { name: "CRONK-2" })).toBeVisible();

  // Escape closes the picker for the word typed.
  await page.keyboard.type(" and CRONK-");
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
  for (const _ of " and CRONK-") await page.keyboard.press("Backspace");
  await page.keyboard.type(".");

  await page.getByRole("button", { name: "Save as Version 2" }).click();
  await expect.poll(saved).toBe("Follows CRONK-1 on a Lane. Then CRONK-2.\n");
});
