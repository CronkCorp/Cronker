import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

const page = (text: string) => ({ path: "index.html", contentBase64: Buffer.from(`<h1>${text}</h1>`).toString("base64") });

test("a Document embedding a pinned Version shows it in a sandboxed frame that can be resized and opened", async ({ page: tab, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const slug = (await (await cronk.request("GET", `/api/workspaces/${workspace.id}`, { cookie })).json()).slug;
  const created = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/artifacts`, { cookie, body: { title: "Board", files: [page("Version one")] } })
  ).json();
  await cronk.request("PATCH", `/api/artifacts/${created.id}`, { cookie, body: { baseVersion: 1, files: [page("Version two")] } });
  const address = `${cronk.url}/${slug}/artifacts/${created.slug}?version=1`;
  const document = await (
    await cronk.request("POST", `/api/workspaces/${workspace.id}/documents`, {
      cookie,
      body: { title: "Roadmap", body: `The board as it was:\n\n${address}\n\nAnd in a sentence, <${address}> stays a link.` },
    })
  ).json();

  await signInInBrowser(tab, cronk);
  await tab.goto(`${cronk.url}/documents/${document.id}`);
  const body = tab.getByRole("article", { name: "Roadmap" });
  const embed = body.getByRole("figure", { name: "Embedded Artifact Board" });
  await expect(embed).toHaveCount(1);

  // The same sandbox as on the Artifact's page, showing the Version the address pins rather than the latest.
  const frame = embed.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  await expect(embed.frameLocator("iframe").getByRole("heading")).toHaveText("Version one");
  // The address in a sentence is an ordinary link.
  await expect(body.getByRole("link", { name: address })).toBeVisible();

  // Dragging the handle makes the frame taller; the arrow keys move it too.
  const before = (await frame.boundingBox())!.height;
  const handle = embed.getByRole("separator", { name: "Resize Board" });
  const grip = (await handle.boundingBox())!;
  await tab.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await tab.mouse.down();
  await tab.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 200, { steps: 5 });
  await tab.mouse.up();
  await expect.poll(async () => (await frame.boundingBox())!.height).toBeGreaterThan(before + 150);
  const dragged = (await frame.boundingBox())!.height;
  await handle.focus();
  await tab.keyboard.press("ArrowDown");
  await expect.poll(async () => (await frame.boundingBox())!.height).toBeGreaterThan(dragged);

  // Open leads to the Artifact's page at the pinned Version.
  await embed.getByRole("link", { name: "Open" }).click();
  await expect(tab).toHaveURL(new RegExp(`/${slug}/artifacts/${created.slug}\\?version=1$`));
  await expect(tab.getByRole("heading", { name: "Board" })).toBeVisible();
  await expect(tab.frameLocator("iframe.artifact-frame").getByRole("heading")).toHaveText("Version one");
  await tab.getByRole("link", { name: "Show the latest" }).click();
  await expect(tab.frameLocator("iframe.artifact-frame").getByRole("heading")).toHaveText("Version two");
});
