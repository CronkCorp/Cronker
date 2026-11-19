import { createSign } from "node:crypto";
import type { Config } from "../config.js";
import { ApiError } from "../http/errors.js";
import type { AppCredentials } from "./app.js";

/**
 * The calls Cronk makes to GitHub, at the addresses in its configuration, so tests and
 * GitHub Enterprise Server can point it elsewhere. Anything GitHub can't answer becomes
 * `github_unavailable`.
 */

const unavailable = (detail: string) =>
  new ApiError(502, "github_unavailable", `GitHub couldn't be reached or refused Cronk's request: ${detail}`);

/** The path under a base address that may itself have a path, such as GitHub Enterprise Server's `/api/v3`. */
export function under(base: URL, path: string): URL {
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
  app: AppCredentials,
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

/** The App's identity on GitHub's API: its id and private key. */
export interface AppKey {
  appId: number;
  privateKey: string;
}

/**
 * A JSON web token the App signs with its private key, which GitHub takes as the App itself
 * for ten minutes at most. Backdated a minute against clocks running apart.
 */
export function appJwt({ appId, privateKey }: AppKey, now: Date): string {
  const seconds = Math.floor(now.getTime() / 1000);
  const encode = (part: unknown) => Buffer.from(JSON.stringify(part)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

/** Every item of a list GitHub pages through, following its `Link: <…>; rel="next"` headers. */
async function allPages<T>(first: URL, token: string, what: string, itemsOf: (body: unknown) => T[]): Promise<T[]> {
  const items: T[] = [];
  let url: URL | undefined = first;
  url.searchParams.set("per_page", "100");
  // GitHub caps what it lists; 100 pages of 100 is far beyond any installation Cronk serves.
  for (let pages = 0; url && pages < 100; pages++) {
    const response = await call(url, { headers: { authorization: `Bearer ${token}` } });
    items.push(...itemsOf(await jsonOf<unknown>(response, what)));
    const next = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get("link") ?? "")?.[1];
    // The token goes only where the first page came from.
    url = next && new URL(next).origin === first.origin ? new URL(next) : undefined;
  }
  return items;
}

export interface AppOnGitHub {
  slug: string;
  owner: { login: string; type: string };
  permissions: Record<string, string>;
  events: string[];
}

/** The App as GitHub has it now, with what it asks for, edited by hand or not. */
export async function appOnGitHub({ github }: Config, jwt: string): Promise<AppOnGitHub> {
  const response = await call(under(github.apiUrl, "/app"), { headers: { authorization: `Bearer ${jwt}` } });
  return jsonOf<AppOnGitHub>(response, "/app");
}

/** Where the App's webhook deliveries go, and whether they're signed; nothing if it has no webhook. */
export async function appWebhook({ github }: Config, jwt: string): Promise<{ url: string; hasSecret: boolean } | undefined> {
  const response = await call(under(github.apiUrl, "/app/hook/config"), { headers: { authorization: `Bearer ${jwt}` } });
  if (response.status === 404) return undefined;
  const config = await jsonOf<{ url?: string; secret?: string | null }>(response, "/app/hook/config");
  return { url: config.url ?? "", hasSecret: Boolean(config.secret) };
}

export interface InstallationOnGitHub {
  id: number;
  account: { login: string };
  html_url: string;
  /** What the installation's owner has accepted, which may lag behind what the App asks for. */
  permissions: Record<string, string>;
}

/** Every installation of the App. */
export async function appInstallations({ github }: Config, jwt: string): Promise<InstallationOnGitHub[]> {
  return allPages(under(github.apiUrl, "/app/installations"), jwt, "/app/installations", (body) => body as InstallationOnGitHub[]);
}

/** A new token for acting on one installation's Repositories, and when GitHub says it expires. */
export async function installationToken(
  { github }: Config,
  jwt: string,
  installationId: number,
): Promise<{ token: string; expiresAt: Date }> {
  const url = under(github.apiUrl, `/app/installations/${installationId}/access_tokens`);
  const response = await call(url, { method: "POST", headers: { authorization: `Bearer ${jwt}` } });
  const body = await jsonOf<{ token: string; expires_at: string }>(response, "The installation token request");
  return { token: body.token, expiresAt: new Date(body.expires_at) };
}

/** The repositories an installation covers. */
export async function installationRepositories({ github }: Config, token: string): Promise<{ id: number; full_name: string }[]> {
  return allPages(
    under(github.apiUrl, "/installation/repositories"),
    token,
    "/installation/repositories",
    (body) => (body as { repositories: { id: number; full_name: string }[] }).repositories,
  );
}

/** One attempt at one of the App's webhook deliveries, as GitHub's delivery log lists it. */
export interface DeliveryAttemptOnGitHub {
  /** The attempt's id, which a redelivery is asked for by. */
  id: number;
  /** The delivery's `X-GitHub-Delivery` id, the same for each attempt at it. */
  guid: string;
  event: string;
  /** The HTTP status Cronk answered with, or 0 if GitHub got no answer. */
  status_code: number;
}

/** Every attempt at the App's webhook deliveries GitHub still keeps (three days), newest first. */
export async function appDeliveries({ github }: Config, jwt: string): Promise<DeliveryAttemptOnGitHub[]> {
  const first = under(github.apiUrl, "/app/hook/deliveries");
  return allPages(first, jwt, "/app/hook/deliveries", (body) => body as DeliveryAttemptOnGitHub[]);
}

/** Asks GitHub to send a delivery again, by the id of one attempt at it. */
export async function redeliver({ github }: Config, jwt: string, attemptId: number): Promise<void> {
  const url = under(github.apiUrl, `/app/hook/deliveries/${attemptId}/attempts`);
  const response = await call(url, { method: "POST", headers: { authorization: `Bearer ${jwt}` } });
  if (!response.ok) throw unavailable(`The redelivery request answered ${response.status}`);
}
