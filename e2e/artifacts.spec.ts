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
  await expect(page.locator(".page-head-meta")).toContainText("Version 1");
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

test("an Artifact's page lists its Versions, who saved each and when, and compares two file by file, showing files added and removed", async ({
  page,
  cronk,
}) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const agent = await (await cronk.request("POST", `/api/workspaces/${workspace.id}/agents`, { cookie, body: { name: "claude-max" } })).json();
  const token = await (await cronk.request("POST", `/api/agents/${agent.id}/tokens`, { cookie, body: { name: "laptop", access: "full" } })).json();
  const created = await cronk.request("POST", `/api/workspaces/${workspace.id}/artifacts`, {
    cookie,
    body: {
      title: "Board prototype",
      files: [
        { path: "index.html", contentBase64: base64("<h1>Board</h1>\n<p>Drag cards.</p>") },
        { path: "app.js", contentBase64: base64("start();") },
      ],
    },
  });
  const artifact = await created.json();
  const saved = await cronk.request("PATCH", `/api/artifacts/${artifact.id}`, {
    headers: { authorization: `Bearer ${token.secret}` },
    body: {
      baseVersion: 1,
      files: [
        { path: "index.html", contentBase64: base64("<h1>Board</h1>\n<p>Drag cards between columns.</p>") },
        { path: "data/cards.json", contentBase64: base64('["Write the spec"]') },
      ],
      remove: ["app.js"],
    },
  });
  expect(saved.status).toBe(200);
  await signInInBrowser(page, cronk);

  await page.goto(`${cronk.url}/artifacts/${artifact.id}`);

  const versions = page.getByRole("region", { name: "Versions" });
  await expect(versions.getByRole("listitem")).toHaveText([/Version 2.*claude-max/, /Version 1.*ada@example\.com/]);
  await versions.getByLabel("Compare Version 1").check();
  await versions.getByLabel("Compare Version 2").check();

  const dialog = page.getByRole("dialog", { name: "What changed" });
  const fileShown = (path: string) => dialog.getByRole("region", { name: path, exact: true });
  await expect(fileShown("app.js")).toContainText("Removed");
  await expect(fileShown("app.js").locator("del")).toHaveText("start();");
  await expect(fileShown("data/cards.json")).toContainText("Added");
  await expect(fileShown("data/cards.json").locator("ins")).toHaveText('["Write the spec"]');
  const changed = fileShown("index.html");
  await expect(changed).toContainText("Changed");
  await expect(changed.locator("del")).toHaveText("<p>Drag cards.</p>");
  await expect(changed.locator("ins")).toHaveText("<p>Drag cards between columns.</p>");

  // A save from elsewhere joins the list in place.
  await cronk.request("PATCH", `/api/artifacts/${artifact.id}`, { cookie, body: { baseVersion: 2, title: "Board" } });
  await page.keyboard.press("Escape");
  await expect(versions.getByRole("listitem")).toHaveCount(3);
});
