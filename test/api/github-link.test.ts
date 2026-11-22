import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { addMember, createGitHubApp, linkGitHub, navigate, setUp, signIn, signInWithGitHub } from "../harness/flows.js";
import { startCronk, type StartedCronk } from "../harness/start-cronk.js";

let cronk: StartedCronk;
beforeEach(async () => {
  cronk = await startCronk();
});
afterEach(async () => {
  await cronk?.stop();
});

const me = async (cookie: string) => (await (await cronk.request("GET", "/api/me", { cookie })).json()).user;

describe("linking a GitHub account", () => {
  test("a User who signs in with a password links a GitHub account of another email, and returns to their settings page", async () => {
    const { user } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const account = cronk.github.account("ada-gh", "ada@elsewhere.example.com");

    const linked = await linkGitHub(cronk, cookie, account);

    expect(linked.location).toBe("/account?github=linked");
    expect(await me(cookie)).toEqual({ id: user.id, email: "ada@example.com", githubLogin: "ada-gh", displayName: null });
    // The account now signs in as the User.
    const signedIn = await signInWithGitHub(cronk, account);
    expect(signedIn.location).toBe("/");
    expect((await me(signedIn.cookie!)).id).toBe(user.id);
  });

  test("someone an Admin added by this GitHub login, who never signed in, is the User linking it: they join where added", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const other = await (await cronk.request("POST", "/api/workspaces", { cookie, body: { name: "Other" } })).json();
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");
    const account = cronk.github.account("bea-gh", "bea@elsewhere.example.com");
    const added = await cronk.request("POST", `/api/workspaces/${other.id}/members/github`, { cookie, body: { login: "bea-gh" } });
    expect(added.status).toBe(201);

    const linked = await linkGitHub(cronk, bea.cookie, account);

    expect(linked.location).toBe("/account?github=linked");
    const after = await (await cronk.request("GET", "/api/me", { cookie: bea.cookie })).json();
    expect(after.user).toEqual({ id: bea.user.id, email: "bea@example.com", githubLogin: "bea-gh", displayName: null });
    expect(after.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([workspace.id, other.id].sort());
  });
});

describe("linking a GitHub account: refusals", () => {
  test("a GitHub account linked to another User is refused, and stays theirs", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const account = cronk.github.account("ada-gh", "ada@example.com");
    await signInWithGitHub(cronk, account);
    const bea = await addMember(cronk, cookie, workspace.id, "bea@example.com");

    const linked = await linkGitHub(cronk, bea.cookie, account);

    expect(linked.location).toBe("/account?github_link_error=github_account_taken");
    expect((await me(bea.cookie)).githubLogin).toBeNull();
    expect((await me(cookie)).githubLogin).toBe("ada-gh");
  });

  test("a User with a GitHub account linked isn't sent to link another", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    await linkGitHub(cronk, cookie, cronk.github.account("ada-gh"));

    const again = await linkGitHub(cronk, cookie, cronk.github.account("ada-alt"));

    expect(again.location).toBe("/account?github_link_error=github_already_linked");
    expect((await me(cookie)).githubLogin).toBe("ada-gh");
  });

  test("linking needs a sign-in", async () => {
    await setUp(cronk);
    await createGitHubApp(cronk, await signIn(cronk));

    const start = await navigate(`${cronk.url}/api/github/link`);

    expect(start.headers.get("location")).toBe("/account?github_link_error=not_signed_in");
  });

  test("without a GitHub App, linking says so", async () => {
    await setUp(cronk);

    const linked = await linkGitHub(cronk, await signIn(cronk), cronk.github.account("ada-gh"));

    expect(linked.location).toBe("/account?github_link_error=github_not_set_up");
  });

  test("GitHub not authorizing links nothing", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    cronk.github.signedInAs = null;
    const start = await navigate(`${cronk.url}/api/github/link`, cookie);
    const stateCookie = start.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("cronk_github_state="));
    const atGitHub = await navigate(start.headers.get("location")!);

    const back = await navigate(atGitHub.headers.get("location")!, stateCookie);

    expect(back.headers.get("location")).toBe("/account?github_link_error=github_denied");
    expect((await me(cookie)).githubLogin).toBeNull();
  });

  test("a link finishes only in the browser that started it: an attacker's callback link attaches nothing to the victim", async () => {
    const { workspace } = await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    const mallory = await addMember(cronk, cookie, workspace.id, "mallory@example.com");
    cronk.github.signedInAs = cronk.github.account("mallory-gh");
    const start = await navigate(`${cronk.url}/api/github/link`, mallory.cookie);
    const atGitHub = await navigate(start.headers.get("location")!);

    // Ada's browser opens Mallory's callback link, without Mallory's state cookie.
    const back = await navigate(atGitHub.headers.get("location")!, cookie);

    expect(back.headers.get("location")).toBe("/account?github_link_error=invalid_state");
    expect((await me(cookie)).githubLogin).toBeNull();
    expect((await me(mallory.cookie)).githubLogin).toBeNull();
  });

  test("a link must come back within ten minutes", async () => {
    await setUp(cronk);
    const cookie = await signIn(cronk);
    await createGitHubApp(cronk, cookie);
    cronk.github.signedInAs = cronk.github.account("ada-gh");
    const start = await navigate(`${cronk.url}/api/github/link`, cookie);
    const stateCookie = start.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("cronk_github_state="));
    const atGitHub = await navigate(start.headers.get("location")!);
    cronk.clock.advance(10 * 60 * 1000);

    const back = await navigate(atGitHub.headers.get("location")!, stateCookie);

    expect(back.headers.get("location")).toBe("/account?github_link_error=invalid_state");
    expect((await me(cookie)).githubLogin).toBeNull();
  });
});
