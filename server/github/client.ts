import type { Config } from "../config.js";
import { ApiError } from "../http/errors.js";

/**
 * The calls Cronk makes to GitHub, at the addresses in its configuration, so tests and
 * GitHub Enterprise Server can point it elsewhere. Anything GitHub can't answer becomes
 * `github_unavailable`.
 */

const unavailable = (detail: string) =>
  new ApiError(502, "github_unavailable", `GitHub couldn't be reached or refused Cronk's request: ${detail}`);

function under(base: URL, path: string): URL {
  return new URL(`${base.href.replace(/\/$/, "")}${path}`);
}

async function call(url: URL, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Cronk",
        "x-github-api-version": "2022-11-28",
        ...init.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw unavailable(error instanceof Error ? error.message : String(error));
  }
}

async function jsonOf<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) throw unavailable(`${what} answered ${response.status}`);
  try {
    return (await response.json()) as T;
  } catch {
    throw unavailable(`${what} answered something other than JSON`);
  }
}

export interface ConvertedApp {
  id: number;
  slug: string;
  name: string;
  owner: { login: string };
  html_url: string;
  client_id: string;
  client_secret: string;
  webhook_secret: string | null;
  pem: string;
}

/** Turns the code GitHub's manifest flow sends back into the new App's credentials. Works once. */
export async function convertManifest({ github }: Config, code: string): Promise<ConvertedApp> {
  const url = under(github.apiUrl, `/app-manifests/${encodeURIComponent(code)}/conversions`);
  return jsonOf<ConvertedApp>(await call(url, { method: "POST" }), "The manifest conversion");
}

/** Exchanges an OAuth authorization code for a user access token, or nothing if GitHub refuses the code. */
export async function exchangeCode(
  { github }: Config,
  app: { clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
): Promise<string | undefined> {
  const response = await call(under(github.url, "/login/oauth/access_token"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }),
  });
  const body = await jsonOf<{ access_token?: string }>(response, "The OAuth token exchange");
  return body.access_token || undefined;
}

export interface GitHubUser {
  id: number;
  login: string;
  /** The account's primary email, if GitHub says it is verified. */
  verifiedEmail: string | null;
}

/** The GitHub account a user access token belongs to. */
export async function userOf({ github }: Config, token: string): Promise<GitHubUser> {
  const headers = { authorization: `Bearer ${token}` };
  const user = await jsonOf<{ id: number; login: string }>(await call(under(github.apiUrl, "/user"), { headers }), "/user");
  const emails = await call(under(github.apiUrl, "/user/emails"), { headers });
  // Without the email permission there is no verified email to go by, which is not an error.
  const list = emails.ok ? await jsonOf<{ email: string; primary: boolean; verified: boolean }[]>(emails, "/user/emails") : [];
  const primary = list.find((e) => e.primary && e.verified);
  return { id: user.id, login: user.login, verifiedEmail: primary?.email ?? null };
}

/** The GitHub account with this login, or nothing if there is none. */
export async function accountByLogin({ github }: Config, login: string): Promise<{ id: number; login: string } | undefined> {
  const response = await call(under(github.apiUrl, `/users/${encodeURIComponent(login)}`));
  if (response.status === 404) return undefined;
  return jsonOf<{ id: number; login: string }>(response, "/users");
}
