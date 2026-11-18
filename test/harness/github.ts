import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * A stand-in for GitHub, for the parts Cronk uses: creating a GitHub App from a manifest,
 * a User authorizing the App to sign them in (OAuth), and looking up accounts. Like the
 * real thing it redirects the browser, so a test (or Playwright) follows `Location`s.
 *
 * Whoever is "signed in to GitHub" in the browser is `signedInAs`; tests set it.
 */

export interface GitHubAccount {
  id: number;
  login: string;
  /** The account's email addresses; the first verified one marked primary is its primary email. */
  emails: { email: string; primary: boolean; verified: boolean }[];
}

export interface StandInApp {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  pem: string;
  owner: string;
  manifest: Record<string, unknown>;
}

export interface StandInGitHub {
  /** The web address, like `https://github.com`. */
  url: string;
  /** The API address, like `https://api.github.com`. */
  apiUrl: string;
  /** The GitHub account the browser is signed in to GitHub as. */
  signedInAs: GitHubAccount | null;
  /** Every account GitHub knows of, by login. */
  accounts: Map<string, GitHubAccount>;
  /** Apps created through the manifest flow, in order. */
  apps: StandInApp[];
  /** Adds an account GitHub knows of and returns it. */
  account(login: string, email?: string, options?: { verified?: boolean }): GitHubAccount;
  stop(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(302, { location });
  response.end();
}

export async function startStandInGitHub(): Promise<StandInGitHub> {
  let nextId = 1000;
  const manifestCodes = new Map<string, StandInApp>();
  const oauthCodes = new Map<string, { app: StandInApp; account: GitHubAccount; redirectUri: string }>();
  const accessTokens = new Map<string, GitHubAccount>();

  const github: StandInGitHub = {
    url: "",
    apiUrl: "",
    signedInAs: null,
    accounts: new Map(),
    apps: [],
    account(login, email = `${login.toLowerCase()}@users.example.com`, { verified = true } = {}) {
      const account = { id: nextId++, login, emails: [{ email, primary: true, verified }] };
      github.accounts.set(login.toLowerCase(), account);
      return account;
    },
    stop: async () => {},
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", github.url);
    // The API lives under `/api/v3`, as on GitHub Enterprise Server, so Cronk must join paths onto it.
    const path = url.pathname.replace(/^\/api\/v3(?=\/)/, "");
    const bearer = /^(?:Bearer|token) (.+)$/.exec(request.headers.authorization ?? "")?.[1];

    // Web: the manifest form a browser posts to create a GitHub App.
    if (request.method === "POST" && /^\/(?:settings|organizations\/[^/]+\/settings)\/apps\/new$/.test(path)) {
      const manifest = JSON.parse(new URLSearchParams(await readBody(request)).get("manifest") ?? "{}");
      const owner = /^\/organizations\/([^/]+)\//.exec(path)?.[1] ?? github.signedInAs?.login ?? "someone";
      const id = nextId++;
      const app: StandInApp = {
        id,
        slug: String(manifest.name).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        name: manifest.name,
        clientId: `Iv1.${randomBytes(8).toString("hex")}`,
        clientSecret: randomBytes(20).toString("hex"),
        webhookSecret: randomBytes(20).toString("hex"),
        pem: `-----BEGIN RSA PRIVATE KEY-----\n${randomBytes(48).toString("base64")}\n-----END RSA PRIVATE KEY-----\n`,
        owner,
        manifest,
      };
      const code = randomBytes(10).toString("hex");
      manifestCodes.set(code, app);
      const back = new URL(manifest.redirect_url);
      back.searchParams.set("code", code);
      const state = url.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      return redirect(response, back.toString());
    }

    // API: turning the manifest flow's code into the App's credentials, once.
    const conversion = /^\/app-manifests\/([^/]+)\/conversions$/.exec(path);
    if (request.method === "POST" && conversion) {
      const app = manifestCodes.get(conversion[1]!);
      if (!app) return json(response, 404, { message: "Not Found" });
      manifestCodes.delete(conversion[1]!);
      github.apps.push(app);
      return json(response, 201, {
        id: app.id,
        slug: app.slug,
        name: app.name,
        client_id: app.clientId,
        client_secret: app.clientSecret,
        webhook_secret: app.webhookSecret,
        pem: app.pem,
        owner: { login: app.owner },
        html_url: `${github.url}/apps/${app.slug}`,
      });
    }

    // Web: a User authorizing the App to sign them in. Approves at once as `signedInAs`.
    if (request.method === "GET" && path === "/login/oauth/authorize") {
      const app = github.apps.find((a) => a.clientId === url.searchParams.get("client_id"));
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      if (!app) return json(response, 404, { message: "Not Found" });
      if (!(app.manifest.callback_urls as string[]).includes(redirectUri)) {
        return json(response, 400, { message: "redirect_uri is not one of the App's callback URLs" });
      }
      const back = new URL(redirectUri);
      const state = url.searchParams.get("state");
      if (state) back.searchParams.set("state", state);
      if (!github.signedInAs) {
        back.searchParams.set("error", "access_denied");
        return redirect(response, back.toString());
      }
      const code = randomBytes(10).toString("hex");
      oauthCodes.set(code, { app, account: github.signedInAs, redirectUri });
      back.searchParams.set("code", code);
      return redirect(response, back.toString());
    }

    // Web: exchanging the authorization code for a user access token, once.
    if (request.method === "POST" && path === "/login/oauth/access_token") {
      const raw = await readBody(request);
      const params: Record<string, string> = (request.headers["content-type"] ?? "").includes("json")
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
      const grant = oauthCodes.get(params.code ?? "");
      if (
        !grant ||
        grant.app.clientId !== params.client_id ||
        grant.app.clientSecret !== params.client_secret ||
        (params.redirect_uri !== undefined && params.redirect_uri !== grant.redirectUri)
      ) {
        return json(response, 200, { error: "bad_verification_code" });
      }
      oauthCodes.delete(params.code!);
      const token = `ghu_${randomBytes(16).toString("hex")}`;
      accessTokens.set(token, grant.account);
      return json(response, 200, { access_token: token, token_type: "bearer", scope: "" });
    }

    // API: the signed-in account and its email addresses.
    if (request.method === "GET" && (path === "/user" || path === "/user/emails")) {
      const account = bearer ? accessTokens.get(bearer) : undefined;
      if (!account) return json(response, 401, { message: "Bad credentials" });
      if (path === "/user/emails") return json(response, 200, account.emails);
      const primary = account.emails.find((e) => e.primary);
      return json(response, 200, { id: account.id, login: account.login, email: primary?.email ?? null });
    }

    // API: any account by login.
    const byLogin = /^\/users\/([^/]+)$/.exec(path);
    if (request.method === "GET" && byLogin) {
      const account = github.accounts.get(decodeURIComponent(byLogin[1]!).toLowerCase());
      if (!account) return json(response, 404, { message: "Not Found" });
      return json(response, 200, { id: account.id, login: account.login, type: "User" });
    }

    return json(response, 404, { message: "Not Found" });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error) => json(response, 500, { message: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no port");
  github.url = `http://127.0.0.1:${address.port}`;
  github.apiUrl = `${github.url}/api/v3`;
  github.stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return github;
}
