import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, setUp, signIn } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

/** Posts the manifest form to GitHub as the browser does, and returns where GitHub sends the browser back to. */
async function postManifestToGitHub(start: { url: string; manifest: unknown }): Promise<string> {
  const response = await fetch(start.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ manifest: JSON.stringify(start.manifest) }),
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  return response.headers.get("location")!;
}

/** Opens a page by top-level navigation, carrying no `SameSite=Strict` cookie, as after a redirect from GitHub. */
function navigate(url: string, cookie?: string) {
  return fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

describe("creating the GitHub App", () => {
  test("an Admin creates the installation's GitHub App through GitHub's manifest flow", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    expect(await (await cronk.request("GET", "/api/github/app")).json()).toEqual({ app: null });
    cronk.github.signedInAs = cronk.github.account("ada");

    const started = await cronk.request("POST", "/api/github/app/manifest", { cookie, body: {} });
    expect(started.status).toBe(201);
    const start = await started.json();
    expect(start.url).toMatch(new RegExp(`^${cronk.github.url}/settings/apps/new\\?state=.+`));
    expect(start.manifest).toMatchObject({
      url: cronk.url,
      redirect_url: `${cronk.url}/api/github/app/created`,
      callback_urls: [`${cronk.url}/api/github/callback`],
      public: false,
      default_permissions: { emails: "read" },
    });

    const back = await navigate(await postManifestToGitHub(start));
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/github?created=1");

    const [created] = cronk.github.apps;
    expect(await (await cronk.request("GET", "/api/github/app")).json()).toEqual({
      app: { name: created!.name, owner: "ada", htmlUrl: `${cronk.github.url}/apps/${created!.slug}` },
    });
  });
});

/** An Admin creates the GitHub App, as in the test above. */
async function createApp(cookie: string) {
  const started = await cronk.request("POST", "/api/github/app/manifest", { cookie, body: {} });
  expect(started.status).toBe(201);
  const back = await navigate(await postManifestToGitHub(await started.json()));
  expect(back.headers.get("location")).toBe("/github?created=1");
}

describe("creating the GitHub App: refusals", () => {
  test("only an Admin may create the GitHub App", async () => {
    const { workspace } = await setUp(cronk);
    const bea = await addMember(cronk, await signIn(cronk), workspace.id, "bea@example.com");

    const response = await cronk.request("POST", "/api/github/app/manifest", { cookie: bea.cookie, body: {} });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: { code: "not_admin", message: expect.any(String) } });
  });

  test("an installation has one GitHub App: a second is refused, even from a flow started before the first finished", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const early = await (await cronk.request("POST", "/api/github/app/manifest", { cookie, body: {} })).json();
    await createApp(cookie);

    const again = await cronk.request("POST", "/api/github/app/manifest", { cookie, body: {} });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: { code: "github_app_exists", message: expect.any(String) } });

    const late = await navigate(await postManifestToGitHub(early));
    expect(late.headers.get("location")).toBe("/github?error=github_app_exists");
    expect(cronk.github.apps).toHaveLength(1);
  });

  test("GitHub's code is taken only with the state of a flow an Admin started", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const start = await (await cronk.request("POST", "/api/github/app/manifest", { cookie, body: {} })).json();
    const forged = { ...start, url: start.url.replace(/state=[^&]+/, "state=cronk_github_state_forged") };

    const back = await navigate(await postManifestToGitHub(forged));

    expect(back.headers.get("location")).toBe("/github?error=invalid_state");
    expect(await (await cronk.request("GET", "/api/github/app")).json()).toEqual({ app: null });
  });

  test("a manifest flow must come back within an hour", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    const start = await (await cronk.request("POST", "/api/github/app/manifest", { cookie, body: {} })).json();
    cronk.clock.advance(60 * 60 * 1000);

    const back = await navigate(await postManifestToGitHub(start));

    expect(back.headers.get("location")).toBe("/github?error=invalid_state");
  });
});

describe("creating the GitHub App without a secret key", () => {
  test("Cronk without CRONK_SECRET_KEY refuses to create the App, having nothing to encrypt its credentials with", async () => {
    await cronk.stop();
    cronk = await startCronk({ noSecretKey: true });
    await setUp(cronk);
    const cookie = await signIn(cronk);

    const response = await cronk.request("POST", "/api/github/app/manifest", { cookie, body: {} });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "no_secret_key", message: expect.any(String) } });
  });
});
