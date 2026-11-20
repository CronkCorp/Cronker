import type { FrameLocator, Page } from "@playwright/test";
import { setUp, signIn } from "../test/harness/flows.js";
import { expect, signInInBrowser, test } from "./fixtures.js";

const base64 = (text: string) => Buffer.from(text).toString("base64");

/**
 * A page that reports what its scripts could do: whether they ran, whether they could read Cronk's cookies, and
 * whether they could read Cronk's API or change something through it as the signed-in User.
 */
const probePage = `<!doctype html>
<title>Probe</title>
<link rel="stylesheet" href="styles/probe.css">
<p id="ran">Scripts didn't run</p>
<p id="cookies"></p>
<p id="read"></p>
<p id="write"></p>
<script src="scripts/probe.js"></script>`;

const probeScript = `
document.getElementById("ran").textContent = "Scripts ran";
let cookies;
try { cookies = "Cookies: " + (document.cookie || "none"); } catch { cookies = "Cookies: blocked"; }
document.getElementById("cookies").textContent = cookies;
const report = (id) => (text) => { document.getElementById(id).textContent = text; };
fetch("/api/me", { credentials: "include" })
  .then((response) => response.text().then((text) => "Read: " + response.status + " " + text))
  .catch(() => "Read: blocked")
  .then(report("read"));
// A form-like request needs no CORS preflight, so it would reach Cronk if anything let it through.
fetch("/api/workspaces", {
  method: "POST",
  mode: "no-cors",
  credentials: "include",
  headers: { "content-type": "text/plain" },
  body: JSON.stringify({ name: "Taken over" }),
})
  .then(() => "Write: sent", () => "Write: blocked")
  .then(report("write"));
`;

/** What the probe reports, wherever it is shown. */
async function expectSandboxed(probe: FrameLocator | Page) {
  await expect(probe.locator("#ran")).toHaveText("Scripts ran");
  // Its stylesheet, at a relative path, resolved within the Version.
  await expect(probe.locator("#ran")).toHaveCSS("color", "rgb(0, 128, 0)");
  await expect(probe.locator("#cookies")).toHaveText("Cookies: blocked");
  await expect(probe.locator("#read")).toHaveText("Read: blocked");
  await expect(probe.locator("#write")).not.toBeEmpty();
}

test("an Artifact's page shows it in a sandboxed iframe, where its scripts run but can't read Cronk's cookies or call its API, also when opened directly", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/artifacts`, {
    cookie,
    body: {
      title: "Probe",
      description: "What a sandboxed page can reach.",
      files: [
        { path: "index.html", contentBase64: base64(probePage) },
        { path: "scripts/probe.js", contentBase64: base64(probeScript) },
        { path: "styles/probe.css", contentBase64: base64("#ran { color: rgb(0, 128, 0); }") },
      ],
    },
  });
  expect(created.status).toBe(201);
  const artifact = await created.json();
  await signInInBrowser(page, cronk);

  await page.goto(`${cronk.url}/artifacts/${artifact.id}`);

  await expect(page.getByRole("heading", { name: "Probe" })).toBeVisible();
  await expect(page.getByText("What a sandboxed page can reach.")).toBeVisible();
  await expect(page.getByText("Version 1")).toBeVisible();
  const frame = page.locator("iframe");
  await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
  await expect(frame).toHaveAttribute("title", "Probe");
  await expectSandboxed(page.frameLocator("iframe"));

  // Opened directly, from its Open link, it is sandboxed all the same.
  const opened = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open" }).click();
  const direct = await opened;
  expect(new URL(direct.url()).origin).toBe(new URL(cronk.url).origin);
  await expectSandboxed(direct);

  // Nothing it sent changed anything as the signed-in User.
  const { workspaces } = await (await cronk.request("GET", "/api/me", { cookie })).json();
  expect(workspaces.map((w: { name: string }) => w.name)).toEqual([workspace.name]);
});

test("Artifacts are listed per Project and for the Workspace, linked and unlinked on a Ticket, found by search, and deleted by a User", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const post = async (path: string, body: unknown) => (await cronk.request("POST", path, { cookie, body })).json();
  const files = [{ path: "index.html", contentBase64: base64("<!doctype html><p>Board</p>") }];
  const project = await post(`/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await post(`/api/projects/${project.id}/tickets`, { title: "Try drag and drop" });
  await post(`/api/projects/${project.id}/artifacts`, { title: "Inbox sketch", description: "The Inbox, laid out.", files });
  cronk.clock.advance(60_000);
  await post(`/api/projects/${project.id}/artifacts`, { title: "Board prototype", description: "Cards to drag.", files });
  await post(`/api/workspaces/${workspace.id}/artifacts`, { title: "Colour tokens", files });

  await signInInBrowser(page, cronk);
  const sidebar = page.getByRole("navigation", { name: "Sidebar" });
  await sidebar.getByRole("link", { name: "Artifacts" }).click();
  await expect(page.getByRole("heading", { name: "Artifacts", level: 1 })).toBeVisible();
  const list = page.getByRole("region", { name: "Artifacts" });
  await expect(list.getByRole("link")).toHaveText(["Colour tokens"]);
  await page.getByRole("navigation", { name: "Scope" }).getByRole("link", { name: "CRONK" }).click();
  // Newest change first.
  await expect(list.getByRole("link")).toHaveText(["Board prototype", "Inbox sketch"]);
  await expect(list.getByText("Cards to drag.")).toBeVisible();

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const linked = page.getByRole("region", { name: "Linked Artifacts" });
  await linked.getByRole("button", { name: "Link an Artifact…" }).click();
  const picker = page.getByRole("listbox", { name: "Link an Artifact" });
  await expect(picker.getByRole("option")).toHaveText(["Board prototype", "Inbox sketch", "Colour tokens"]);
  await picker.getByRole("option", { name: "Board prototype" }).click();
  await expect(linked.getByRole("link", { name: "Board prototype" })).toBeVisible();
  await expect(page.getByText("linked the Artifact Board prototype")).toBeVisible();
  await linked.getByRole("button", { name: "Unlink" }).click();
  await expect(linked.getByRole("link", { name: "Board prototype" })).toBeHidden();
  await expect(page.getByText("unlinked the Artifact Board prototype")).toBeVisible();

  const box = sidebar.getByRole("searchbox", { name: "Search" });
  await box.fill("drag");
  await box.press("Enter");
  const artifacts = page.getByRole("region", { name: "Artifacts" });
  await expect(artifacts.getByRole("heading", { level: 2 })).toHaveText("Artifacts 1");
  await artifacts.getByRole("link", { name: "Board prototype" }).click();
  await expect(page.getByRole("heading", { name: "Board prototype", level: 1 })).toBeVisible();

  await page.getByRole("button", { name: "More of this Artifact" }).click();
  await page.getByRole("menuitem", { name: "Delete Artifact" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Artifacts", level: 1 })).toBeVisible();
  await expect(list.getByRole("link")).toHaveText(["Inbox sketch"]);
});
