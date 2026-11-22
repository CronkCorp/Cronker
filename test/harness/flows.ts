import { expect } from "vitest";
import type { GitHubAccount } from "./github.js";
import type { StartedCronk } from "./start-cronk.js";

/** Common paths through the API, for tests whose subject comes after them. */

export const firstUser = {
  email: "ada@example.com",
  password: "correct horse battery",
  workspaceName: "Ada's Workspace",
};

export async function setUp(cronk: StartedCronk) {
  const response = await cronk.request("POST", "/api/setup", { body: { ...firstUser, setupCode: cronk.setupCode() } });
  expect(response.status).toBe(201);
  return (await response.json()) as { user: { id: string; email: string }; workspace: { id: string; name: string } };
}

/** Signs in and returns the `Cookie` header value to send with later requests. */
export async function signIn(cronk: StartedCronk, email = firstUser.email, password = firstUser.password) {
  const response = await cronk.request("POST", "/api/sign-in", { body: { email, password } });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0]!;
}

/**
 * An Admin adds someone by email and they join through the link, as a new User.
 * Returns the new member and the `Cookie` header of their sign-in.
 */
export async function addMember(cronk: StartedCronk, adminCookie: string, workspaceId: string, email: string) {
  const password = `${email}'s password`;
  const added = await cronk.request("POST", `/api/workspaces/${workspaceId}/members`, {
    cookie: adminCookie,
    body: { email },
  });
  expect(added.status).toBe(201);
  const { user, link } = (await added.json()) as { user: { id: string; email: string }; link: { url: string } };
  const used = await cronk.request("POST", "/api/links/use", { body: { token: new URL(link.url).hash.slice(1), password } });
  expect(used.status).toBe(200);
  return { user, password, cookie: await signIn(cronk, email, password) };
}

/** Opens a page by top-level navigation, carrying no `SameSite=Strict` cookie, as after a redirect from GitHub. */
export function navigate(url: string, cookie?: string) {
  return fetch(url, { redirect: "manual", headers: cookie ? { cookie } : {} });
}

/** Posts the manifest form to GitHub as the browser does, and returns where GitHub sends the browser back to. */
export async function postManifestToGitHub(start: { url: string; manifest: unknown }): Promise<string> {
  const response = await fetch(start.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ manifest: JSON.stringify(start.manifest) }),
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  return response.headers.get("location")!;
}

/** An Admin creates the installation's GitHub App through the manifest flow. */
export async function createGitHubApp(cronk: StartedCronk, adminCookie: string) {
  const started = await cronk.request("POST", "/api/github/app/manifest", { cookie: adminCookie, body: {} });
  expect(started.status).toBe(201);
  const back = await navigate(await postManifestToGitHub(await started.json()));
  expect(back.headers.get("location")).toBe("/github?created=1");
}

function cookieOf(response: Response, name: string): string | undefined {
  return response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0]!)
    .find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);
}

/**
 * Signs in with GitHub in a browser signed in to GitHub as the account, following each
 * redirect: Cronk to GitHub, GitHub back to Cronk. Returns where Cronk sends the browser
 * last, and the `Cookie` header of the sign-in, if there is one.
 */
export async function signInWithGitHub(cronk: StartedCronk, account: GitHubAccount) {
  cronk.github.signedInAs = account;
  const start = await navigate(`${cronk.url}/api/github/sign-in`);
  expect(start.status).toBe(302);
  const stateCookie = cookieOf(start, "cronk_github_state");
  const atGitHub = await navigate(start.headers.get("location")!);
  expect(atGitHub.status).toBe(302);
  const back = await navigate(atGitHub.headers.get("location")!, stateCookie);
  expect(back.status).toBe(302);
  return { location: back.headers.get("location")!, cookie: cookieOf(back, "cronk_sign_in") };
}

/**
 * Links a GitHub account to the signed-in User in a browser signed in to GitHub as the
 * account, following each redirect: Cronk to GitHub, GitHub back to Cronk without the
 * `SameSite=Strict` sign-in cookie. Returns where Cronk sends the browser last.
 */
export async function linkGitHub(cronk: StartedCronk, cookie: string, account: GitHubAccount) {
  cronk.github.signedInAs = account;
  const start = await navigate(`${cronk.url}/api/github/link`, cookie);
  expect(start.status).toBe(302);
  const location = start.headers.get("location")!;
  if (location.startsWith("/")) return { location };
  const stateCookie = cookieOf(start, "cronk_github_state");
  const atGitHub = await navigate(location);
  expect(atGitHub.status).toBe(302);
  const back = await navigate(atGitHub.headers.get("location")!, stateCookie);
  expect(back.status).toBe(302);
  return { location: back.headers.get("location")! };
}
