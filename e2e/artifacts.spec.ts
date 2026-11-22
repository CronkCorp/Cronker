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

test("Comments on an Artifact show on its page and, marked with the Artifact, on the Ticket linking it, live", async ({ page, cronk }) => {
  const { workspace } = await setUp(cronk);
  const cookie = await signIn(cronk);
  const call = async (method: string, path: string, body?: unknown) => (await cronk.request(method, path, { cookie, body })).json();
  const project = await call("POST", `/api/workspaces/${workspace.id}/projects`, { name: "Cronker", key: "CRONK" });
  const ticket = await call("POST", `/api/projects/${project.id}/tickets`, { title: "Try drag and drop" });
  const artifact = await call("POST", `/api/projects/${project.id}/artifacts`, {
    title: "Board prototype",
    files: [{ path: "index.html", contentBase64: base64("<p>Board</p>") }],
  });
  await call("POST", `/api/tickets/${ticket.id}/artifacts`, { artifactId: artifact.id });
  await signInInBrowser(page, cronk);

  await page.goto(`${cronk.url}/artifacts/${artifact.id}`);
  const comments = page.getByRole("region", { name: "Comments" });
  await expect(comments.getByText("No Comments yet.")).toBeVisible();
  const box = comments.getByRole("textbox", { name: "New Comment" });
  await box.click();
  await page.keyboard.type("The columns are too narrow.");
  await comments.getByRole("button", { name: /^Comment/ }).click();
  await expect(comments.getByRole("article", { name: "Comment by ada@example.com" })).toContainText("The columns are too narrow.");

  // Another's Comment arrives live.
  await call("POST", `/api/artifacts/${artifact.id}/comments`, { body: "Widen them in CRONK-1." });
  await expect(comments.getByText("Widen them in")).toBeVisible();

  await page.goto(`${cronk.url}/tickets/${ticket.id}`);
  const timeline = page.getByRole("region", { name: "Timeline" });
  const onArtifact = timeline.getByRole("article", { name: "Comment by ada@example.com" }).first();
  await expect(onArtifact).toContainText("The columns are too narrow.");
  await expect(onArtifact.getByRole("link", { name: "Board prototype" })).toBeVisible();
  await call("POST", `/api/artifacts/${artifact.id}/comments`, { body: "Done in Version 2." });
  await expect(timeline.getByText("Done in Version 2.")).toBeVisible();
});
