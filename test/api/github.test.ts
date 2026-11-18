import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, navigate, postManifestToGitHub, setUp, signIn, signInWithGitHub } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

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
      app: { name: created!.name, githubAccount: "ada", htmlUrl: `${cronk.github.url}/apps/${created!.slug}` },
    });
  });
});

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
    await createGitHubApp(cronk, cookie);

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

describe("signing in with GitHub", () => {
  test("an existing User signs in with the GitHub account of their email, which links it; their password still works", async () => {
    const { user } = await setUp(cronk);
    await createGitHubApp(cronk, await signIn(cronk));
    const ada = cronk.github.account("ada-gh", "ada@example.com");

    const signedIn = await signInWithGitHub(cronk, ada);

    expect(signedIn.location).toBe("/");
    const me = await (await cronk.request("GET", "/api/me", { cookie: signedIn.cookie })).json();
    expect(me.user).toEqual({ id: user.id, email: "ada@example.com", githubLogin: "ada-gh" });
    expect((await cronk.request("POST", "/api/sign-in", { body: { email: "ada@example.com", password: "correct horse battery" } })).status).toBe(200);
  });

  test("once linked, the GitHub account signs in as its User whatever its email becomes", async () => {
    const { user } = await setUp(cronk);
    await createGitHubApp(cronk, await signIn(cronk));
    const ada = cronk.github.account("ada-gh", "ada@example.com");
    await signInWithGitHub(cronk, ada);
    ada.emails = [{ email: "ada@elsewhere.example.com", primary: true, verified: true }];

    const again = await signInWithGitHub(cronk, ada);

    const me = await (await cronk.request("GET", "/api/me", { cookie: again.cookie })).json();
    expect(me.user.id).toBe(user.id);
  });
});

describe("signing in with GitHub: refusals", () => {
  test("a GitHub account no User has is refused, and nobody is signed in", async () => {
    await setUp(cronk);
    await createGitHubApp(cronk, await signIn(cronk));

    const mallory = await signInWithGitHub(cronk, cronk.github.account("mallory"));

    expect(mallory.location).toBe("/?github_error=unknown_github_user");
    expect(mallory.cookie).toBeUndefined();
  });

  test("an unverified email links nothing", async () => {
    await setUp(cronk);
    await createGitHubApp(cronk, await signIn(cronk));

    const impostor = await signInWithGitHub(cronk, cronk.github.account("not-ada", "ada@example.com", { verified: false }));

    expect(impostor.location).toBe("/?github_error=unknown_github_user");
  });

  test("a User linked to one GitHub account isn't linked to another with the same email", async () => {
    await setUp(cronk);
    await createGitHubApp(cronk, await signIn(cronk));
    await signInWithGitHub(cronk, cronk.github.account("ada-gh", "ada@example.com"));

    const other = await signInWithGitHub(cronk, cronk.github.account("ada-alt", "ada@example.com"));

    expect(other.location).toBe("/?github_error=unknown_github_user");
    const me = await (await cronk.request("GET", "/api/me", { cookie: await signIn(cronk) })).json();
    expect(me.user.githubLogin).toBe("ada-gh");
  });

  test("a sign-in finishes only in the browser that started it", async () => {
    await setUp(cronk);
    await createGitHubApp(cronk, await signIn(cronk));
    cronk.github.signedInAs = cronk.github.account("ada-gh", "ada@example.com");
    const start = await navigate(`${cronk.url}/api/github/sign-in`);
    const atGitHub = await navigate(start.headers.get("location")!);

    // The victim's browser opens the attacker's callback link, without the attacker's state cookie.
    const back = await navigate(atGitHub.headers.get("location")!);

    expect(back.headers.get("location")).toBe("/?github_error=invalid_state");
    expect(back.headers.getSetCookie().some((c) => c.startsWith("cronk_sign_in=") && !c.startsWith("cronk_sign_in=;"))).toBe(false);
  });

  test("without a GitHub App, signing in with GitHub says so", async () => {
    await setUp(cronk);

    const start = await navigate(`${cronk.url}/api/github/sign-in`);

    expect(start.headers.get("location")).toBe("/?github_error=github_not_set_up");
  });
});

describe("adding Users by GitHub login", () => {
  test("an Admin adds someone by GitHub login; their first sign-in with GitHub joins them", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const bea = cronk.github.account("bea", "bea@example.com");

    const added = await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, {
      cookie,
      body: { login: "Bea" },
    });

    expect(added.status).toBe(201);
    const { user } = await added.json();
    expect(user).toEqual({ id: expect.any(String), email: null, githubLogin: "bea" });
    const before = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    expect(before.map((m: { user: { id: string } }) => m.user.id)).not.toContain(user.id);

    const signedIn = await signInWithGitHub(cronk, bea);

    expect(signedIn.location).toBe("/");
    const me = await (await cronk.request("GET", "/api/me", { cookie: signedIn.cookie })).json();
    expect(me).toEqual({
      user: { id: user.id, email: "bea@example.com", githubLogin: "bea" },
      workspaces: [{ id: workspace.id, name: "Ada's Workspace", isAdmin: false }],
    });
    const after = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    expect(after).toContainEqual({ user: me.user, isAdmin: false });
  });
});

describe("adding Users by GitHub login: more", () => {
  test("a GitHub account is one User: added to two Workspaces, it joins both at its next sign-in", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const other = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Other" } })).json();
    const bea = cronk.github.account("bea", "bea@example.com");
    const add = async (workspaceId: string) =>
      (await (await cronk.request("POST", `/api/workspaces/${workspaceId}/members/github`, { cookie, body: { login: "bea" } })).json()).user;

    const first = await add(workspace.id);
    const second = await add(other.id);

    expect(second.id).toBe(first.id);
    const me = await (await cronk.request("GET", "/api/me", { cookie: (await signInWithGitHub(cronk, bea)).cookie })).json();
    expect(me.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([workspace.id, other.id].sort());
  });

  test("a User who already signs in with GitHub joins a Workspace they're added to at their next sign-in", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const bea = cronk.github.account("bea", "bea@example.com");
    await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie, body: { login: "bea" } });
    await signInWithGitHub(cronk, bea);
    const other = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Other" } })).json();

    const added = await cronk.request("POST", `/api/workspaces/${other.id}/members/github`, { cookie, body: { login: "bea" } });
    expect(added.status).toBe(201);
    const beforeSignIn = await (await cronk.request("GET", `/api/workspaces/${other.id}/members`, { cookie })).json();
    expect(beforeSignIn).toHaveLength(1);

    const me = await (await cronk.request("GET", "/api/me", { cookie: (await signInWithGitHub(cronk, bea)).cookie })).json();
    expect(me.workspaces.map((w: { name: string }) => w.name).sort()).toEqual(["Ada's Workspace", "Other"]);
  });
});

describe("pending adds by GitHub login", () => {
  test("an Admin sees who they added by GitHub login until their sign-in joins them", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const bea = cronk.github.account("bea", "bea@example.com");
    const { user } = await (
      await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie, body: { login: "bea" } })
    ).json();

    const pending = await cronk.request("GET", `/api/workspaces/${workspace.id}/pending-adds`, { cookie });

    expect(await pending.json()).toEqual([
      { user: { id: user.id, email: null, githubLogin: "bea" }, addedBy: "github", addedAt: "2026-01-01T09:00:00.000Z", expiresAt: null },
    ]);
    await signInWithGitHub(cronk, bea);
    expect(await (await cronk.request("GET", `/api/workspaces/${workspace.id}/pending-adds`, { cookie })).json()).toEqual([]);
  });

  test("an Admin cancels an add by GitHub login; signing in with GitHub then joins nothing", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const bea = cronk.github.account("bea", "bea@example.com");
    const { user } = await (
      await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie, body: { login: "bea" } })
    ).json();

    const cancelled = await cronk.request("DELETE", `/api/workspaces/${workspace.id}/pending-adds/${user.id}`, { cookie });

    expect(cancelled.status).toBe(204);
    expect(await (await cronk.request("GET", `/api/workspaces/${workspace.id}/pending-adds`, { cookie })).json()).toEqual([]);
    const signedIn = await signInWithGitHub(cronk, bea);
    const me = await (await cronk.request("GET", "/api/me", { cookie: signedIn.cookie })).json();
    expect(me.workspaces).toEqual([]);
    const members = await (await cronk.request("GET", `/api/workspaces/${workspace.id}/members`, { cookie })).json();
    expect(members.map((m: { user: { id: string } }) => m.user.id)).not.toContain(user.id);
  });

  test("cancelling one Workspace's add by GitHub login leaves the others", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const other = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Other" } })).json();
    const bea = cronk.github.account("bea", "bea@example.com");
    const add = async (workspaceId: string) =>
      (await (await cronk.request("POST", `/api/workspaces/${workspaceId}/members/github`, { cookie, body: { login: "bea" } })).json()).user;
    const user = await add(workspace.id);
    await add(other.id);

    await cronk.request("DELETE", `/api/workspaces/${workspace.id}/pending-adds/${user.id}`, { cookie });

    const me = await (await cronk.request("GET", "/api/me", { cookie: (await signInWithGitHub(cronk, bea)).cookie })).json();
    expect(me.workspaces).toEqual([{ id: other.id, name: "Other", isAdmin: false }]);
  });
});

describe("adding Users by GitHub login: refusals", () => {
  test("a login GitHub doesn't know is refused", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie, body: { login: "nobody" } });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: "unknown_github_login", message: expect.any(String) } });
  });

  test("without a GitHub App, nobody can be added by GitHub login", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    cronk.github.account("bea");

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie, body: { login: "bea" } });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "github_not_set_up", message: expect.any(String) } });
  });

  test("a member can't be added again", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    await signInWithGitHub(cronk, cronk.github.account("ada-gh", "ada@example.com"));

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie, body: { login: "ada-gh" } });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "already_member", message: expect.any(String) } });
  });

  test("only an Admin adds people by GitHub login", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    cronk.github.account("cy");
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");

    const response = await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie: bea.cookie, body: { login: "cy" } });

    expect(response.status).toBe(403);
  });
});

describe("a password and GitHub sign-in together", () => {
  test("a User who joined with GitHub can't be given a password by an Admin's join link", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const bea = cronk.github.account("bea", "bea@example.com");
    await cronk.request("POST", `/api/workspaces/${workspace.id}/members/github`, { cookie, body: { login: "bea" } });
    await signInWithGitHub(cronk, bea);
    // Another Workspace's Admin adds Bea's email, hoping to set her password with the link.
    const other = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Other" } })).json();
    const { link } = await (
      await cronk.request("POST", `/api/workspaces/${other.id}/members`, { cookie, body: { email: "bea@example.com" } })
    ).json();
    const token = new URL(link.url).hash.slice(1);

    const details = await (await cronk.request("POST", "/api/links/lookup", { body: { token } })).json();
    expect(details).toMatchObject({ setsPassword: false, signInWithGitHub: true });
    const used = await cronk.request("POST", "/api/links/use", { body: { token, password: "mallory's password" } });

    expect(used.status).toBe(409);
    expect(await used.json()).toEqual({ error: { code: "sign_in_with_github", message: expect.any(String) } });
    expect((await cronk.request("POST", "/api/sign-in", { body: { email: "bea@example.com", password: "mallory's password" } })).status).toBe(401);
  });

  test("a User added by email who signs in with the GitHub account of that email joins", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    await cronk.request("POST", `/api/workspaces/${workspace.id}/members`, { cookie, body: { email: "bea@example.com" } });

    const signedIn = await signInWithGitHub(cronk, cronk.github.account("bea", "bea@example.com"));

    const me = await (await cronk.request("GET", "/api/me", { cookie: signedIn.cookie })).json();
    expect(me.user).toMatchObject({ email: "bea@example.com", githubLogin: "bea" });
    expect(me.workspaces).toEqual([{ id: workspace.id, name: "Ada's Workspace", isAdmin: false }]);
  });
});

describe("one person, one User", () => {
  test("someone added by GitHub login who already has a User by email becomes that User at their first GitHub sign-in", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const beaOnGitHub = cronk.github.account("bea", "bea@example.com");
    const other = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Other" } })).json();
    const added = await cronk.request("POST", `/api/workspaces/${other.id}/members/github`, { cookie, body: { login: "bea" } });
    expect(added.status).toBe(201);

    const signedIn = await signInWithGitHub(cronk, beaOnGitHub);

    const me = await (await cronk.request("GET", "/api/me", { cookie: signedIn.cookie })).json();
    expect(me.user).toEqual({ id: bea.user.id, email: "bea@example.com", githubLogin: "bea" });
    expect(me.workspaces.map((w: { name: string }) => w.name).sort()).toEqual(["Ada's Workspace", "Other"]);
    expect((await cronk.request("POST", "/api/sign-in", { body: { email: "bea@example.com", password: bea.password } })).status).toBe(200);
  });
});
