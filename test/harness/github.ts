import { createHmac, createPublicKey, generateKeyPair, randomBytes, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Clock } from "../../server/clock.js";

/**
 * A stand-in for GitHub, for the parts Cronk uses: creating a GitHub App from a manifest,
 * a User authorizing the App to sign them in (OAuth), looking up accounts, the App asking
 * about itself and its installations with its JWT, installation tokens, the repositories an
 * installation covers, and sending the App's webhook deliveries signed with its secret.
 * Like the real thing it redirects the browser, so a test (or Playwright) follows `Location`s.
 *
 * Whoever is "signed in to GitHub" in the browser is `signedInAs`; tests set it. Times,
 * such as when an installation token expires, come from the clock Cronk is given.
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
  /** The secret GitHub signs deliveries with; GitHub makes one only for a manifest with a webhook. */
  webhookSecret: string | null;
  pem: string;
  owner: string;
  /** Whether `owner` is an organization, whose Apps' settings live under `/organizations/<owner>`. */
  ownedByOrganization: boolean;
  manifest: Record<string, unknown>;
  /** What the App asks for, as its settings on GitHub say: from the manifest, then as edited by hand. */
  permissions: Record<string, string>;
  events: string[];
  /** Where GitHub sends the App's webhook deliveries, if anywhere. */
  webhookUrl: string | null;
}

export interface StandInRepository {
  id: number;
  name: string;
  /** `owner/name`. */
  fullName: string;
}

export interface StandInInstallation {
  id: number;
  app: StandInApp;
  account: string;
  /** What the installation's owner has accepted, which lags behind the App's own until they accept. */
  permissions: Record<string, string>;
  events: string[];
  repositories: StandInRepository[];
  /** The owner accepts the App's current permissions and events, as on the installation's page on GitHub. */
  accept(): void;
}

export interface IssuedToken {
  installationId: number;
  token: string;
  expiresAt: Date;
}

export interface DeliveryOptions {
  /** The `X-GitHub-Delivery` id; a new one by default. Sending one again is a redelivery. */
  id?: string;
  /** The secret to sign with: the App's own by default, `null` for no signature at all. */
  secret?: string | null;
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
  /** Every installation of every App, in order. */
  installations: StandInInstallation[];
  /** Installs the App on an account, which accepts its current permissions, covering these repository names. */
  install(app: StandInApp, account: string, repositories?: string[]): StandInInstallation;
  /** Every installation token GitHub issued, in order. */
  tokensIssued: IssuedToken[];
  /**
   * Sends one of the App's webhook deliveries to its webhook URL, as GitHub does: the event's
   * name, a delivery id and the body's `X-Hub-Signature-256`. Returns Cronk's answer.
   */
  deliver(app: StandInApp, event: string, payload: unknown, options?: DeliveryOptions): Promise<Response>;
  stop(): Promise<void>;
}

/** GitHub's installation tokens last an hour. */
const tokenLifetimeMs = 60 * 60 * 1000;

/** One RSA key pair for every App, made once, since making one takes a while. */
let keyPair: Promise<{ privateKey: string; publicKey: KeyObject }> | undefined;
function appKeys() {
  keyPair ??= new Promise((resolve, reject) =>
    generateKeyPair(
      "rsa",
      { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } },
      (error, publicKey, privateKey) => (error ? reject(error) : resolve({ privateKey, publicKey: createPublicKey(publicKey) })),
    ),
  );
  return keyPair;
}

/** The App a JWT was signed by, if its signature checks out with the App's key and it hasn't expired. */
function appOfJwt(jwt: string, apps: StandInApp[], publicKey: KeyObject, now: Date): StandInApp | undefined {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) return undefined;
  try {
    if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "RS256") return undefined;
    if (!verify("sha256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))) return undefined;
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: unknown; iat?: number; exp?: number };
    const seconds = now.getTime() / 1000;
    // GitHub refuses a JWT that has expired, was issued in the future or lasts more than ten minutes.
    if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return undefined;
    if (claims.exp <= seconds || claims.iat > seconds + 60 || claims.exp - claims.iat > 600) return undefined;
    return apps.find((a) => String(a.id) === String(claims.iss) || a.clientId === claims.iss);
  } catch {
    return undefined;
  }
}

/** One page of a list, with GitHub's `Link` header pointing at the next. */
function page<T>(url: URL, items: T[]): { items: T[]; link?: string } {
  const perPage = Math.min(Number(url.searchParams.get("per_page") ?? 30) || 30, 100);
  const number = Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1);
  const slice = items.slice((number - 1) * perPage, number * perPage);
  if (number * perPage >= items.length) return { items: slice };
  const next = new URL(url);
  next.searchParams.set("page", String(number + 1));
  return { items: slice, link: `<${next}>; rel="next"` };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, location: string) {
  response.writeHead(302, { location });
  response.end();
}

export async function startStandInGitHub(clock: Clock): Promise<StandInGitHub> {
  const keys = await appKeys();
  let nextId = 1000;
  const manifestCodes = new Map<string, StandInApp>();
  const oauthCodes = new Map<string, { app: StandInApp; account: GitHubAccount; redirectUri: string }>();
  const accessTokens = new Map<string, GitHubAccount>();
  const installationTokens = new Map<string, IssuedToken>();

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
    installations: [],
    install(app, account, repositories = []) {
      const installation: StandInInstallation = {
        id: nextId++,
        app,
        account,
        permissions: { ...app.permissions },
        events: [...app.events],
        repositories: repositories.map((name) => ({ id: nextId++, name, fullName: `${account}/${name}` })),
        accept() {
          installation.permissions = { ...app.permissions };
          installation.events = [...app.events];
        },
      };
      github.installations.push(installation);
      return installation;
    },
    tokensIssued: [],
    async deliver(app, event, payload, { id = randomBytes(8).toString("hex"), secret = app.webhookSecret } = {}) {
      if (!app.webhookUrl) throw new Error(`the App ${app.slug} has no webhook URL`);
      const body = JSON.stringify(payload);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "user-agent": "GitHub-Hookshot/stand-in",
        "x-github-event": event,
        "x-github-delivery": id,
        "x-github-hook-installation-target-type": "integration",
        "x-github-hook-installation-target-id": String(app.id),
      };
      if (secret !== null) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      return fetch(app.webhookUrl, { method: "POST", headers, body });
    },
    stop: async () => {},
  };

  const installationJson = (i: StandInInstallation) => ({
    id: i.id,
    app_id: i.app.id,
    app_slug: i.app.slug,
    account: { login: i.account, type: "User" },
    target_type: "User",
    permissions: i.permissions,
    events: i.events,
    html_url: `${github.url}/settings/installations/${i.id}`,
    repository_selection: "selected",
  });

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
        webhookSecret: manifest.hook_attributes?.url ? randomBytes(20).toString("hex") : null,
        pem: keys.privateKey,
        owner,
        ownedByOrganization: path.startsWith("/organizations/"),
        manifest,
        permissions: { ...(manifest.default_permissions ?? {}) },
        events: [...(manifest.default_events ?? [])],
        webhookUrl: manifest.hook_attributes?.url ?? null,
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

    // API: the App asking about itself and its installations, signed in with its JWT.
    if (path === "/app" || path.startsWith("/app/")) {
      const app = bearer ? appOfJwt(bearer, github.apps, keys.publicKey, clock.now()) : undefined;
      if (!app) return json(response, 401, { message: "A JSON web token could not be decoded" });

      if (request.method === "GET" && path === "/app") {
        return json(response, 200, {
          id: app.id,
          slug: app.slug,
          name: app.name,
          client_id: app.clientId,
          owner: { login: app.owner, type: app.ownedByOrganization ? "Organization" : "User" },
          html_url: `${github.url}/apps/${app.slug}`,
          permissions: app.permissions,
          events: app.events,
        });
      }
      if (request.method === "GET" && path === "/app/hook/config") {
        // GitHub never shows the secret, only that there is one.
        return json(response, 200, {
          content_type: "json",
          insecure_ssl: "0",
          url: app.webhookUrl ?? "",
          ...(app.webhookSecret ? { secret: "********" } : {}),
        });
      }
      if (request.method === "GET" && path === "/app/installations") {
        const { items, link } = page(url, github.installations.filter((i) => i.app === app));
        return json(response, 200, items.map(installationJson), link ? { link } : {});
      }
      const tokenFor = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
      if (request.method === "POST" && tokenFor) {
        const installation = github.installations.find((i) => i.app === app && String(i.id) === tokenFor[1]);
        if (!installation) return json(response, 404, { message: "Not Found" });
        const issued = {
          installationId: installation.id,
          token: `ghs_${randomBytes(16).toString("hex")}`,
          expiresAt: new Date(clock.now().getTime() + tokenLifetimeMs),
        };
        installationTokens.set(issued.token, issued);
        github.tokensIssued.push(issued);
        return json(response, 201, {
          token: issued.token,
          expires_at: issued.expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
          permissions: installation.permissions,
          repository_selection: "selected",
        });
      }
      return json(response, 404, { message: "Not Found" });
    }

    // API: the repositories an installation covers, with one of its unexpired tokens.
    if (request.method === "GET" && path === "/installation/repositories") {
      const issued = bearer ? installationTokens.get(bearer) : undefined;
      const installation = github.installations.find((i) => i.id === issued?.installationId);
      if (!issued || !installation || issued.expiresAt <= clock.now()) return json(response, 401, { message: "Bad credentials" });
      const { items, link } = page(url, installation.repositories);
      const repositories = items.map((r) => ({
        id: r.id,
        name: r.name,
        full_name: r.fullName,
        owner: { login: installation.account },
        private: true,
        html_url: `${github.url}/${r.fullName}`,
      }));
      return json(response, 200, { total_count: installation.repositories.length, repositories }, link ? { link } : {});
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
