import { setUp, signIn } from "../test/harness/flows.js";
import { expect, fieldPicker, pick, signInInBrowser, test } from "./fixtures.js";

test("a blocked card shows Blocked by N, names its blockers, and follows them live on the board and the List", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await cronk.request(method, path, { cookie, body });
    expect(response.status, `${method} ${path}`).toBeLessThan(300);
    return response.status === 204 ? null : response.json();
  };
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const website = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Website", key: "WEB" });
  const status = (name: string) => project.statuses.find((s: { name: string }) => s.name === name).id as string;
  const signInTicket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Sign in" });
  const board = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Board" });
  const landing = await call("POST", `/api/projects/${website.id}/tickets`, { title: "Landing page" });

  // Ada marks CRONK-2 blocked by CRONK-1 on its Ticket view.
  await signInInBrowser(page, cronk);
  await page.goto(`${cronk.url}/tickets/${board.id}`);
  const relations = page.getByRole("region", { name: "Relations" });
  await pick(page, "Relation", "Blocked by");
  await expect(fieldPicker(page, "Relation")).toHaveAccessibleName("Relation Blocked by");
  await relations.getByLabel("Ticket", { exact: true }).fill("CRONK-1");
  await relations.getByRole("button", { name: "Add" }).click();
  await expect(relations.getByRole("list", { name: "Blocked by", exact: true })).toContainText("CRONK-1 Sign in");

  // On the board, its card shows the chip; the unblocked card shows none.
  await page.getByRole("link", { name: "CRONK Cronker" }).click();
  const lane = (name: string) => page.getByRole("region", { name: "Board" }).getByRole("region", { name, exact: true });
  const chip = lane("Backlog").getByRole("button", { name: /^Blocked by/ });
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText("Blocked by 1");
  await expect(chip).toHaveAccessibleName("Blocked by 1: CRONK-1 Sign in");

  // A blocker in another Project, added elsewhere, counts at once and shows its key.
  await call("POST", `/api/tickets/${landing.id}/relations`, { kind: "blocks", ticketId: board.id });
  await expect(chip).toHaveText("Blocked by 2");

  // Hovering the chip names the blockers, each a link to its Ticket.
  await chip.hover();
  const blockers = page.getByRole("dialog", { name: "Tickets blocking CRONK-2" });
  await expect(blockers.getByRole("link")).toHaveText(["CRONK-1 Sign in", "WEB-1 Landing page"]);
  await page.mouse.move(0, 0);
  await expect(blockers).toBeHidden();

  // Focusing it does too, and the links lead to the blockers.
  await chip.focus();
  await expect(blockers).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(blockers).toBeHidden();
  // Pressing it takes focus to the first link, and Escape gives focus back to the chip.
  await page.keyboard.press("Enter");
  await expect(blockers.getByRole("link", { name: "CRONK-1 Sign in" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(blockers).toBeHidden();
  await expect(chip).toBeFocused();
  await chip.hover();
  await blockers.getByRole("link", { name: "WEB-1 Landing page" }).click();
  await expect(page.getByRole("heading", { name: "WEB-1 Landing page" })).toBeVisible();
  await page.goBack();

  // A blocker finishing stops counting; the last one finishing takes the chip away; Reopening brings it back.
  await call("PATCH", `/api/tickets/${landing.id}`, { statusId: website.statuses.find((s: { kind: string }) => s.kind === "done").id });
  await expect(chip).toHaveText("Blocked by 1");
  await call("PATCH", `/api/tickets/${signInTicket.id}`, { statusId: status("Canceled") });
  await expect(chip).toHaveCount(0);
  await call("PATCH", `/api/tickets/${signInTicket.id}`, { statusId: status("Implement") });
  await expect(chip).toHaveText("Blocked by 1");

  // The List view's rows show the same chip.
  await page.getByRole("link", { name: "List" }).click();
  const listChip = page.getByRole("region", { name: "List" }).getByRole("button", { name: /^Blocked by/ });
  await expect(listChip).toHaveAccessibleName("Blocked by 1: CRONK-1 Sign in");
  await listChip.hover();
  await expect(page.getByRole("dialog", { name: "Tickets blocking CRONK-2" }).getByRole("link")).toHaveText(["CRONK-1 Sign in"]);
  await page.mouse.move(0, 0);

  // Removing the block takes it away.
  const [relation] = (await call("GET", `/api/tickets/${board.id}/relations`)).relations;
  await call("DELETE", `/api/tickets/${board.id}/relations/${relation.id}`);
  await expect(listChip).toHaveCount(0);
});
