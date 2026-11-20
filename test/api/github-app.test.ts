import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, navigate, postManifestToGitHub, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

/** An Admin creates the App as Cronk did before it read Pull Requests: for sign-in only, with no webhook. */
async function createSignInOnlyApp(cookie: string, githubOrganization?: string) {
  const started = await cronk.request("POST", "/api/github/app/manifest", { cookie, body: { githubOrganization } });
  const start = await started.json();
  const { default_events, hook_attributes, ...signInOnly } = start.manifest;
  const back = await navigate(
    await postManifestToGitHub({ ...start, manifest: { ...signInOnly, default_permissions: { emails: "read" } } }),
  );
  expect(back.headers.get("location")).toBe("/github?created=1");
  return cronk.github.apps[0]!;
}

/** The App's installations as a User's listing gets them, `refresh` asking GitHub afresh. */
async function listInstallations(cookie: string, { refresh = false } = {}) {
  const response = await cronk.request("GET", `/api/github/installations${refresh ? "?refresh=true" : ""}`, { cookie });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json();
}

const checklist = async (cookie: string) => cronk.request("GET", "/api/github/app/checklist", { cookie });

describe("upgrading the GitHub App", () => {
  test("an App created from Cronk's manifest has everything Cronk needs", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    cronk.github.signedInAs = cronk.github.account("ada");
    await createGitHubApp(cronk, cookie);
    const app = cronk.github.apps[0]!;

    const response = await checklist(cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      settingsUrl: `${cronk.github.url}/settings/apps/${app.slug}`,
      missingPermissions: {},
      missingEvents: [],
      webhook: null,
      installationsNotAccepted: [],
    });
  });

  test("an App created for sign-in only lists what it lacks, with the webhook URL and secret to paste", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    cronk.github.signedInAs = cronk.github.account("ada");
    const app = await createSignInOnlyApp(cookie);

    const listed = await (await checklist(cookie)).json();

    expect(listed).toEqual({
      settingsUrl: `${cronk.github.url}/settings/apps/${app.slug}`,
      missingPermissions: { metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read" },
      missingEvents: ["pull_request", "pull_request_review", "check_run", "check_suite", "status", "repository"],
      webhook: { url: `${cronk.url}/api/github/webhooks`, secret: expect.stringMatching(/.{32,}/) },
      installationsNotAccepted: [],
    });
    // The secret stays the same until it's pasted.
    expect((await (await checklist(cookie)).json()).webhook.secret).toBe(listed.webhook.secret);
  });

  test("once the Admin adds what was missing on GitHub, the list is empty and deliveries are accepted", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const app = await createSignInOnlyApp(cookie);
    const { webhook } = await (await checklist(cookie)).json();

    // The Admin edits the App's settings on GitHub.
    app.permissions = { ...app.permissions, metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read" };
    app.events = ["pull_request", "pull_request_review", "check_run", "check_suite", "status", "repository"];
    app.webhookUrl = webhook.url;
    app.webhookSecret = webhook.secret;

    // GitHub never shows the secret, so the first delivery signed with it is what confirms it.
    expect((await (await checklist(cookie)).json()).webhook).toEqual(webhook);
    const delivered = await cronk.github.deliver(app, "ping", { zen: "Upgraded." });
    expect(await delivered.json()).toEqual({ applied: true });
    expect(await (await checklist(cookie)).json()).toMatchObject({
      missingPermissions: {},
      missingEvents: [],
      webhook: null,
    });
  });

  test("a webhook pointing elsewhere is listed", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    cronk.github.apps[0]!.webhookUrl = "https://old-tunnel.example.com/api/github/webhooks";

    const { webhook } = await (await checklist(cookie)).json();

    expect(webhook).toEqual({ url: `${cronk.url}/api/github/webhooks`, secret: expect.any(String) });
  });

  test("a webhook already pointing at Cronk with a secret Cronk doesn't know is listed, with the secret to paste", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const app = await createSignInOnlyApp(cookie);
    app.webhookUrl = `${cronk.url}/api/github/webhooks`;
    app.webhookSecret = "a secret the Admin made up on GitHub";

    const { webhook } = await (await checklist(cookie)).json();

    expect(webhook).toEqual({ url: `${cronk.url}/api/github/webhooks`, secret: expect.any(String) });
    expect((await cronk.github.deliver(app, "ping", { zen: "Not ours." })).status).toBe(401);
    expect((await (await checklist(cookie)).json()).webhook).toEqual(webhook);

    app.webhookSecret = webhook.secret;
    expect((await cronk.github.deliver(app, "ping", { zen: "Ours." })).status).toBe(200);
    expect((await (await checklist(cookie)).json()).webhook).toBeNull();
  });

  test("an App owned by an organization links to its settings under the organization", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const app = await createSignInOnlyApp(cookie, "acme");

    const { settingsUrl } = await (await checklist(cookie)).json();

    expect(settingsUrl).toBe(`${cronk.github.url}/organizations/acme/settings/apps/${app.slug}`);
  });

  test("installations that haven't accepted the App's new permissions are listed until their owner accepts", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const app = await createSignInOnlyApp(cookie);
    const acme = cronk.github.install(app, "acme", ["api"]);
    cronk.github.install(app, "bea", ["notes"]);
    app.permissions = { ...app.permissions, metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read" };
    cronk.github.installations[1]!.accept();

    const before = await (await checklist(cookie)).json();

    expect(before.installationsNotAccepted).toEqual([
      {
        account: "acme",
        htmlUrl: `${cronk.github.url}/settings/installations/${acme.id}`,
        missingPermissions: { metadata: "read", contents: "write", pull_requests: "write", checks: "read", statuses: "read" },
      },
    ]);
    acme.accept();
    expect((await (await checklist(cookie)).json()).installationsNotAccepted).toEqual([]);
  });
});

describe("upgrading the GitHub App to write to Repositories", () => {
  /** An App as Cronk created it before Runs pushed and agents merged: read-only on Repositories. */
  const readOnly = { emails: "read", metadata: "read", pull_requests: "read", checks: "read", statuses: "read" };

  test("an App that only reads lists contents and Pull Requests to give write access, and the installations yet to accept", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const app = cronk.github.apps[0]!;
    app.permissions = { ...readOnly };
    const acme = cronk.github.install(app, "acme", ["api"]);

    const before = await (await checklist(cookie)).json();
    expect(before.missingPermissions).toEqual({ contents: "write", pull_requests: "write" });
    // An installation's owner can only accept what the App asks for, so none is listed yet.
    expect(before.installationsNotAccepted).toEqual([]);

    // The Admin gives the App write access on GitHub; acme's owner hasn't accepted it yet.
    app.permissions = { ...readOnly, contents: "write", pull_requests: "write" };
    const after = await (await checklist(cookie)).json();
    expect(after.missingPermissions).toEqual({});
    expect(after.installationsNotAccepted).toEqual([
      {
        account: "acme",
        htmlUrl: `${cronk.github.url}/settings/installations/${acme.id}`,
        missingPermissions: { contents: "write", pull_requests: "write" },
      },
    ]);

    acme.accept();
    expect((await (await checklist(cookie)).json()).installationsNotAccepted).toEqual([]);
  });

  test("an App lacking only one of them lists just that one", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    cronk.github.apps[0]!.permissions = { ...readOnly, contents: "read", pull_requests: "write" };

    const { missingPermissions } = await (await checklist(cookie)).json();

    expect(missingPermissions).toEqual({ contents: "write" });
  });
});

describe("upgrading the GitHub App: installations", () => {
  test("an installation isn't listed for permissions the App itself doesn't ask for yet", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const app = await createSignInOnlyApp(cookie);
    cronk.github.install(app, "acme", ["api"]);

    const before = await (await checklist(cookie)).json();
    expect(before.installationsNotAccepted).toEqual([]);

    app.permissions = { ...app.permissions, metadata: "read", pull_requests: "write" };
    const after = await (await checklist(cookie)).json();
    expect(after.installationsNotAccepted).toEqual([
      { account: "acme", htmlUrl: expect.any(String), missingPermissions: { metadata: "read", pull_requests: "write" } },
    ]);
  });
});

describe("upgrading the GitHub App: refusals", () => {
  test("only an Admin sees the checklist, which holds the webhook secret", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createSignInOnlyApp(cookie);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");

    const response = await checklist(bea.cookie);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "not_admin", message: expect.any(String) } });
  });

  test("without a GitHub App there is nothing to upgrade", async () => {
    await setUp(cronk);

    const response = await checklist(await signIn(cronk));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "github_not_set_up", message: expect.any(String) } });
  });
});

describe("the App's installations", () => {
  test("a User sees the App's installations and the Repositories each covers", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const app = cronk.github.apps[0]!;
    const many = Array.from({ length: 105 }, (_, n) => `service-${String(n).padStart(3, "0")}`);
    cronk.github.install(app, "acme", many);
    const bea = cronk.github.install(app, "bea", ["notes"]);
    const member = await addMember(cronk, cookie, workspace.id, "cy@example.com");

    const response = await cronk.request("GET", "/api/github/installations", { cookie: member.cookie });

    expect(response.status).toBe(200);
    const installations = await response.json();
    expect(installations).toHaveLength(2);
    expect(installations[0].account).toBe("acme");
    expect(installations[0].repositories).toHaveLength(105);
    expect(installations[0].repositories[104]).toEqual({ id: expect.any(Number), fullName: "acme/service-104" });
    expect(installations[1]).toEqual({ account: "bea", repositories: [{ id: bea.repositories[0]!.id, fullName: "bea/notes" }] });
  });

  test("each installation's Repositories are sorted by owner/name, ignoring case", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    cronk.github.install(cronk.github.apps[0]!, "acme", ["website", "Cronker", "api", "Docs", "cronk"]);

    const installations = await (await cronk.request("GET", "/api/github/installations", { cookie })).json();

    expect(installations[0].repositories.map((r: { fullName: string }) => r.fullName)).toEqual([
      "acme/api",
      "acme/cronk",
      "acme/Cronker",
      "acme/Docs",
      "acme/website",
    ]);
  });

  test("installations are listed by account, ignoring case", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const app = cronk.github.apps[0]!;
    cronk.github.install(app, "zeta", ["api"]);
    cronk.github.install(app, "Bea", ["notes"]);
    cronk.github.install(app, "acme", ["site"]);

    const installations = await (await cronk.request("GET", "/api/github/installations", { cookie })).json();

    expect(installations.map((i: { account: string }) => i.account)).toEqual(["acme", "Bea", "zeta"]);
  });

  test("GitHub being unavailable is refused with github_unavailable", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    cronk.github.install(cronk.github.apps[0]!, "acme", ["api"]);
    cronk.github.unavailable = true;

    const response = await cronk.request("GET", "/api/github/installations", { cookie });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: "github_unavailable", message: expect.any(String) } });
  });

  test("installation tokens are fetched once and reused until shortly before they expire", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const acme = cronk.github.install(cronk.github.apps[0]!, "acme", ["api"]);
    // Refresh asks GitHub each time, rather than using the list Cronk keeps.
    const list = () => listInstallations(cookie, { refresh: true });

    await list();
    await list();
    expect(cronk.github.tokensIssued).toHaveLength(1);
    expect(cronk.github.tokensIssued[0]!.installationId).toBe(acme.id);

    // GitHub's tokens last an hour; 54 minutes on, the first is still used.
    cronk.clock.advance(54 * 60 * 1000);
    await list();
    expect(cronk.github.tokensIssued).toHaveLength(1);

    // Within five minutes of its expiry, a new one is fetched, and then reused in turn.
    cronk.clock.advance(2 * 60 * 1000);
    await list();
    await list();
    expect(cronk.github.tokensIssued).toHaveLength(2);
  });

  test("a second listing within five minutes makes no calls to GitHub", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const acme = cronk.github.install(cronk.github.apps[0]!, "acme", ["api"]);
    await listInstallations(cookie);
    const calls = cronk.github.apiCalls.length;

    // Installed on another Repository on GitHub since; the list Cronk keeps doesn't know yet.
    acme.repositories.push({ id: 990001, name: "docs", fullName: "acme/docs" });
    cronk.clock.advance(4 * 60 * 1000);
    const again = await listInstallations(cookie);

    expect(cronk.github.apiCalls.length).toBe(calls);
    expect(again).toEqual([{ account: "acme", repositories: [{ id: acme.repositories[0]!.id, fullName: "acme/api" }] }]);
  });

  test("the list is asked of GitHub again once five minutes have passed", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const acme = cronk.github.install(cronk.github.apps[0]!, "acme", ["api"]);
    await listInstallations(cookie);

    acme.repositories.push({ id: 990001, name: "docs", fullName: "acme/docs" });
    cronk.clock.advance(5 * 60 * 1000);
    const calls = cronk.github.apiCalls.length;
    const again = await listInstallations(cookie);

    expect(cronk.github.apiCalls.slice(calls)).toEqual(["GET /app/installations", "GET /installation/repositories"]);
    expect(again[0].repositories.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/api", "acme/docs"]);
  });

  test("Refresh asks GitHub at once, for an installation or Repository just added there", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const app = cronk.github.apps[0]!;
    const acme = cronk.github.install(app, "acme", ["api"]);
    await listInstallations(cookie);

    acme.repositories.push({ id: 990001, name: "docs", fullName: "acme/docs" });
    cronk.github.install(app, "bea", ["notes"]);
    const refreshed = await listInstallations(cookie, { refresh: true });

    const names = (list: { repositories: { fullName: string }[] }[]) => list.map((i) => i.repositories.map((r) => r.fullName));
    expect(names(refreshed)).toEqual([["acme/api", "acme/docs"], ["bea/notes"]]);
    // What Refresh got is kept in turn.
    const calls = cronk.github.apiCalls.length;
    expect(names(await listInstallations(cookie))).toEqual([["acme/api", "acme/docs"], ["bea/notes"]]);
    expect(cronk.github.apiCalls.length).toBe(calls);
  });

  test("without a GitHub App there are no installations to list", async () => {
    await setUp(cronk);

    const response = await cronk.request("GET", "/api/github/installations", { cookie: await signIn(cronk) });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "github_not_set_up", message: expect.any(String) } });
  });
});
