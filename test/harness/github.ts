import { createHash, createHmac, createPublicKey, generateKeyPair, randomBytes, verify, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Clock } from "../../server/clock.js";

/**
 * A stand-in for GitHub, for the parts Cronk uses: creating a GitHub App from a manifest,
 * a User authorizing the App to sign them in (OAuth), looking up accounts, the App asking
 * about itself and its installations with its JWT, installation tokens, the repositories an
 * installation covers (listed, or one by id), branches and tags and the refs created in them, the GitHub Releases created, a Pull Request with its mergeability, a repository's issues, and sending the App's webhook deliveries signed with its secret,
 * keeping a log of them the App may list and ask to redeliver from.
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
  /** Whether its settings allow each merge method; GitHub allows all three unless a test says otherwise. */
  mergeMethods?: Partial<Record<MergeMethod, boolean>>;
  /** Its default branch: `main` unless a test says otherwise. */
  defaultBranch?: string;
  /** Its branches by name, each with the commit it points at; until a test sets them, only its default branch. */
  branches?: Map<string, string>;
  /** Its tags by name, each with the commit it points at; none until a test sets them or the App creates one. */
  tags?: Map<string, string>;
}

/** A GitHub Release GitHub created at the App's request. */
export interface StandInRelease {
  /** `owner/name`. */
  repository: string;
  tag: string;
  name: string;
  body: string;
  /** Its address on GitHub. */
  url: string;
}

/** A ref GitHub created at the App's request. */
export interface StandInRef {
  /** `owner/name`. */
  repository: string;
  /** Such as `refs/heads/release/v0.3.0`. */
  ref: string;
  sha: string;
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** A Pull Request as GitHub's API answers about it and merges it, apart from the webhook deliveries a test sends. */
export interface StandInPullRequest {
  repository: StandInRepository;
  number: number;
  headSha: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  /** Whether GitHub says it can be merged: null while GitHub is still working it out, as after a push. */
  mergeable: boolean | null;
  /** The base branch's name; `main` by default. */
  base: string;
  /** The base branch's commit GitHub worked mergeability out against; `b0` by default. */
  baseSha: string;
  /**
   * When set, what each ask about it answers in turn instead of `mergeable`, the last one staying: whether it can be
   * merged (null while GitHub works it out), alone or worked out against another base commit than `baseSha`.
   */
  answers: (boolean | null | { mergeable: boolean | null; baseSha: string })[];
  /**
   * Whether its base branch has commits its head lacks, though it merges cleanly: GitHub then answers `mergeable_state`
   * `behind` and, as in a Repository requiring up-to-date branches, refuses to merge it until its branch is updated.
   */
  behind: boolean;
  /**
   * The other Pull Requests its merge makes conflict with their base branch: once it merges, each answers it can't be
   * merged, worked out against the merge commit.
   */
  conflicts: StandInPullRequest[];
  /** The merge commit GitHub made merging it, `m<number>`; null until it merges. */
  mergeCommit: string | null;
}

/** A branch update GitHub made at the App's request, moving a Pull Request's head to a new commit. */
export interface StandInBranchUpdate {
  /** `owner/name`. */
  repository: string;
  number: number;
  /** The head commit before, and the one GitHub made merging the base branch into it. */
  from: string;
  to: string;
  installationId: number;
}

/** An issue as GitHub's issues list answers about it; a Pull Request is listed among them too, marked as one. */
export interface StandInIssue {
  repository: StandInRepository;
  number: number;
  nodeId: string;
  title: string;
  body: string | null;
  state: "open" | "closed";
  /** Why it was closed: `completed` or `not_planned`; null while open. */
  stateReason: "completed" | "not_planned" | null;
  /** Its Labels' names. */
  labels: string[];
  createdAt: Date;
  /** Whether it is a Pull Request, which GitHub's issues list includes. */
  pullRequest: boolean;
  /** The issue it is a sub-issue of, if any, which lists it among its sub-issues. */
  parent: StandInIssue | null;
  /** The issues it is blocked by. */
  blockedBy: StandInIssue[];
  /** Who opened it; null for an account GitHub has since deleted. `octocat` by default. */
  author: GitHubAccount | null;
  assignees: GitHubAccount[];
  /** Its Comments, in the order they were written. */
  comments: StandInIssueComment[];
  /** Whether GitHub answers 404 for its Comments, as for an issue it no longer shows the App. */
  commentsRefused: boolean;
}

/** A Comment on an issue. */
export interface StandInIssueComment {
  /** Who wrote it; null for an account GitHub has since deleted. */
  author: GitHubAccount | null;
  body: string;
  createdAt: Date;
}

/** A merge GitHub made at the App's request. */
export interface StandInMerge {
  /** `owner/name`. */
  repository: string;
  number: number;
  method: MergeMethod;
  /** The head commit the merge request named, if it named one. */
  sha: string | null;
  /** The installation whose token asked for it. */
  installationId: number;
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
  /**
   * How the delivery fails, as GitHub records it: `unreachable` never reaches Cronk (it or its
   * tunnel is down), `timed out` reaches Cronk but GitHub gives up waiting for its answer.
   */
  fails?: "unreachable" | "timed out";
}

/** One attempt at a delivery, as the App's delivery log on GitHub lists it. */
export interface DeliveryAttempt {
  /** The attempt's own id, which a redelivery is asked for by. */
  id: number;
  /** The delivery's `X-GitHub-Delivery` id, the same for each attempt at it. */
  guid: string;
  event: string;
  redelivery: boolean;
  /** The HTTP status Cronk answered with, or 0 if GitHub got no answer. */
  statusCode: number;
  sentAt: Date;
  /** What GitHub sent, to send it again. */
  payload: unknown;
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
  /** Adds, or changes, a Pull Request of the repository as GitHub's API answers about it; open and mergeable by default. */
  pullRequest(repository: StandInRepository, number: number, fields?: Partial<Omit<StandInPullRequest, "repository" | "number">>): StandInPullRequest;
  /**
   * Files an issue in the repository, numbered after the last, as GitHub's issues list answers about it: open, with
   * no Labels and created now, unless `fields` say otherwise.
   */
  issue(repository: StandInRepository, fields?: Partial<Omit<StandInIssue, "repository" | "number" | "nodeId">>): StandInIssue;
  /** Every issue of every repository, in the order they were filed. */
  issues: StandInIssue[];
  /** Every ask for an issue's sub-issues or blockers, as `owner/name#number/sub_issues` or `…/dependencies/blocked_by`. */
  linkRequests: string[];
  /** When set, the asks for an issue's links it picks, as `linkRequests` writes them, answer 502. */
  linksFail: ((asked: string) => boolean) | null;
  /**
   * Rate-limits the issues list until `until` by the clock, as GitHub does once the App has used up its requests: a
   * 403 (by default) or 429 with no requests remaining and `X-RateLimit-Reset`, or with `Retry-After` in seconds
   * instead when `header` says so. With `only: "comments"`, it limits issues' Comments alone, so the list still answers.
   */
  rateLimitIssues(until: Date, options?: { status?: 403 | 429; header?: "reset" | "retry-after"; only?: "comments" }): void;
  /** Rate-limits the asks for an issue's sub-issues and blockers until `until`, as `rateLimitIssues` does the list. */
  rateLimitLinks(until: Date, options?: { status?: 403 | 429; header?: "reset" | "retry-after" }): void;
  /** Every merge the App asked of GitHub's API that GitHub made, oldest first. */
  merges: StandInMerge[];
  /** Every ref the App asked GitHub's API to create that GitHub created, oldest first. */
  refsCreated: StandInRef[];
  /** Every GitHub Release the App asked GitHub's API to create that GitHub created, oldest first. */
  releasesCreated: StandInRelease[];
  /** Repositories, by `owner/name`, where creating a GitHub Release fails with a 500 until a test removes them. */
  failingReleases: Set<string>;
  /** The branch updates GitHub made at the App's request, in order; each clears `behind` and moves the head. */
  updates: StandInBranchUpdate[];
  /** Called while GitHub updates a branch, before it answers, as a test's look at Cronk mid-update. */
  onUpdate: ((update: StandInBranchUpdate) => void | Promise<void>) | null;
  /**
   * Called once GitHub has made a merge, before it answers the request, as when GitHub's webhook delivery of the
   * merge reaches Cronk before the answer does.
   */
  onMerge: ((merge: StandInMerge) => Promise<void>) | null;
  /**
   * Sends one of the App's webhook deliveries to its webhook URL, as GitHub does: the event's
   * name, a delivery id and the body's `X-Hub-Signature-256`. Returns Cronk's answer.
   */
  deliver(app: StandInApp, event: string, payload: unknown, options?: DeliveryOptions): Promise<Response>;
  /** Every attempt at each App's deliveries, by App id, oldest first; GitHub lists them newest first. */
  deliveries: Map<number, DeliveryAttempt[]>;
  /** The attempts made because the App asked GitHub to redeliver, oldest first. */
  redeliveries(app: StandInApp): DeliveryAttempt[];
  /** Answers the App's next redelivery request with 422, as GitHub does for a delivery it no longer keeps. */
  refuseNextRedelivery(): void;
  /** While true, GitHub's API answers every call with 503, as during an outage. */
  unavailable: boolean;
  /** Every call made to GitHub's API, oldest first, as `METHOD /path` without the query, to count what Cronk asks. */
  apiCalls: string[];
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

/** An account as GitHub names it in an issue or a Comment; `null` for one it has since deleted. */
const accountJson = (account: GitHubAccount | null) => (account ? { id: account.id, login: account.login, type: "User" } : null);

const allows = (repository: StandInRepository, method: MergeMethod) => repository.mergeMethods?.[method] ?? true;

const defaultBranchOf = (repository: StandInRepository) => repository.defaultBranch ?? "main";

/** The repository's branches, starting with its default branch at a commit of its own. */
export function branchesOf(repository: StandInRepository): Map<string, string> {
  repository.branches ??= new Map([[defaultBranchOf(repository), createHash("sha1").update(repository.fullName).digest("hex")]]);
  return repository.branches;
}

/** The repository's tags. */
export function tagsOf(repository: StandInRepository): Map<string, string> {
  repository.tags ??= new Map();
  return repository.tags;
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
  /** Who opens an issue when a test names nobody: an account no User links. */
  const octocat: GitHubAccount = { id: 1, login: "octocat", emails: [] };
  const manifestCodes = new Map<string, StandInApp>();
  const oauthCodes = new Map<string, { app: StandInApp; account: GitHubAccount; redirectUri: string }>();
  const accessTokens = new Map<string, GitHubAccount>();
  const installationTokens = new Map<string, IssuedToken>();
  let refuseRedelivery = false;
  const pullRequests = new Map<string, StandInPullRequest>();
  type Limit = { until: Date; status: 403 | 429; header: "reset" | "retry-after"; only?: "comments" };
  let issuesLimit: Limit | undefined;
  let linksLimit: Limit | undefined;
  const rateLimited = (response: ServerResponse, limit: Limit) => {
    const resetSeconds = Math.ceil(limit.until.getTime() / 1000);
    const headers: Record<string, string> =
      limit.header === "reset"
        ? { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetSeconds) }
        : { "retry-after": String(Math.max(0, resetSeconds - Math.floor(clock.now().getTime() / 1000))) };
    const message = { message: "API rate limit exceeded for installation.", documentation_url: "https://docs.github.com/rest/rate-limit" };
    json(response, limit.status, message, headers);
  };

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
        repositories: repositories.map((name) => ({
          id: nextId++,
          name,
          fullName: `${account}/${name}`,
        })),
        accept() {
          installation.permissions = { ...app.permissions };
          installation.events = [...app.events];
        },
      };
      github.installations.push(installation);
      return installation;
    },
    tokensIssued: [],
    pullRequest(repository, number, fields = {}) {
      const key = `${repository.id}#${number}`;
      const pullRequest = pullRequests.get(key) ?? {
        repository,
        number,
        headSha: "aaaa",
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        base: "main",
        baseSha: "b0",
        answers: [],
        behind: false,
        conflicts: [],
        mergeCommit: null,
      };
      Object.assign(pullRequest, fields);
      pullRequests.set(key, pullRequest);
      return pullRequest;
    },
    issue(repository, fields = {}) {
      const number = github.issues.filter((i) => i.repository === repository).length + 1;
      const issue: StandInIssue = {
        repository,
        number,
        nodeId: `I_${randomBytes(8).toString("hex")}`,
        title: `Issue ${number}`,
        body: null,
        state: "open",
        stateReason: null,
        labels: [],
        createdAt: clock.now(),
        pullRequest: false,
        author: octocat,
        assignees: [],
        comments: [],
        commentsRefused: false,
        parent: null,
        blockedBy: [],
        ...fields,
      };
      github.issues.push(issue);
      return issue;
    },
    issues: [],
    linkRequests: [],
    linksFail: null,
    rateLimitIssues(until, { status = 403, header = "reset", only } = {}) {
      issuesLimit = { until, status, header, only };
    },
    rateLimitLinks(until, { status = 403, header = "reset" } = {}) {
      linksLimit = { until, status, header };
    },
    merges: [],
    refsCreated: [],
    releasesCreated: [],
    failingReleases: new Set(),
    updates: [],
    onUpdate: null,
    onMerge: null,
    async deliver(app, event, payload, { id = randomBytes(8).toString("hex"), secret = app.webhookSecret, fails } = {}) {
      return send(app, { guid: id, event, payload, redelivery: false }, secret, fails);
    },
    deliveries: new Map(),
    redeliveries: (app) => (github.deliveries.get(app.id) ?? []).filter((d) => d.redelivery),
    refuseNextRedelivery() {
      refuseRedelivery = true;
    },
    unavailable: false,
    apiCalls: [],
    stop: async () => {},
  };

  /** Sends a delivery to the App's webhook URL, signed, and records the attempt in its delivery log. */
  async function send(
    app: StandInApp,
    delivery: Pick<DeliveryAttempt, "guid" | "event" | "payload" | "redelivery">,
    secret: string | null,
    fails?: DeliveryOptions["fails"],
  ): Promise<Response> {
    if (!app.webhookUrl) throw new Error(`the App ${app.slug} has no webhook URL`);
    const log = github.deliveries.get(app.id) ?? [];
    github.deliveries.set(app.id, log);
    const { guid, event, payload, redelivery } = delivery;
    const attempt: DeliveryAttempt = { id: nextId++, guid, event, payload, redelivery, statusCode: 0, sentAt: clock.now() };
    log.push(attempt);
    if (fails === "unreachable") return new Response(null, { status: 502 });
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "GitHub-Hookshot/stand-in",
      "x-github-event": event,
      "x-github-delivery": guid,
      "x-github-hook-installation-target-type": "integration",
      "x-github-hook-installation-target-id": String(app.id),
    };
    if (secret !== null) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const response = await fetch(app.webhookUrl, { method: "POST", headers, body });
    if (fails !== "timed out") attempt.statusCode = response.status;
    return response;
  }

  const deliveryJson = (d: DeliveryAttempt) => ({
    id: d.id,
    guid: d.guid,
    delivered_at: d.sentAt.toISOString(),
    redelivery: d.redelivery,
    duration: 0.1,
    status: d.statusCode >= 200 && d.statusCode < 300 ? "OK" : d.statusCode === 0 ? "timed out" : `Invalid HTTP Response: ${d.statusCode}`,
    status_code: d.statusCode,
    event: d.event,
    action: null,
    installation_id: null,
    repository_id: null,
  });

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
    if (url.pathname.startsWith("/api/v3/")) github.apiCalls.push(`${request.method} ${path}`);
    if (github.unavailable && url.pathname.startsWith("/api/v3/")) return json(response, 503, { message: "Service Unavailable" });

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
      if (request.method === "GET" && path === "/app/hook/deliveries") {
        const { items, link } = page(url, [...(github.deliveries.get(app.id) ?? [])].reverse());
        return json(response, 200, items.map(deliveryJson), link ? { link } : {});
      }
      const attempts = /^\/app\/hook\/deliveries\/(\d+)\/attempts$/.exec(path);
      if (request.method === "POST" && attempts) {
        const delivery = github.deliveries.get(app.id)?.find((d) => String(d.id) === attempts[1]);
        if (!delivery) return json(response, 404, { message: "Not Found" });
        if (refuseRedelivery) {
          refuseRedelivery = false;
          return json(response, 422, { message: "Validation Failed" });
        }
        // GitHub answers at once and redelivers soon after; the stand-in redelivers first, so a test needn't wait.
        await send(app, { ...delivery, redelivery: true }, app.webhookSecret);
        return json(response, 202, {});
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

    // API: one repository by GitHub's id, with a token of an installation that covers it.
    const byId = /^\/repositories\/(\d+)$/.exec(path);
    if (request.method === "GET" && byId) {
      const issued = bearer ? installationTokens.get(bearer) : undefined;
      const installation = github.installations.find((i) => i.id === issued?.installationId);
      if (!issued || !installation || issued.expiresAt <= clock.now()) return json(response, 401, { message: "Bad credentials" });
      const repository = installation.repositories.find((r) => String(r.id) === byId[1]);
      if (!repository) return json(response, 404, { message: "Not Found" });
      return json(response, 200, {
        id: repository.id,
        name: repository.name,
        full_name: repository.fullName,
        owner: { login: repository.fullName.split("/")[0] },
        private: true,
        html_url: `${github.url}/${repository.fullName}`,
        allow_merge_commit: allows(repository, "merge"),
        allow_squash_merge: allows(repository, "squash"),
        allow_rebase_merge: allows(repository, "rebase"),
        default_branch: defaultBranchOf(repository),
      });
    }

    // API: one branch's or tag's ref, creating a ref, and creating a GitHub Release, with a token of an installation
    // that covers the repository.
    const gitRef = /^\/repos\/([^/]+\/[^/]+)\/(?:git\/(?:ref\/(heads|tags)\/(.+)|refs)|(releases))$/.exec(path);
    const reading = request.method === "GET" && gitRef?.[2];
    const writing = request.method === "POST" && gitRef && !gitRef[2];
    if (gitRef && (reading || writing)) {
      const issued = bearer ? installationTokens.get(bearer) : undefined;
      const installation = github.installations.find((i) => i.id === issued?.installationId);
      if (!issued || !installation || issued.expiresAt <= clock.now()) return json(response, 401, { message: "Bad credentials" });
      const repository = installation.repositories.find((r) => r.fullName.toLowerCase() === decodeURIComponent(gitRef[1]!).toLowerCase());
      if (!repository) return json(response, 404, { message: "Not Found" });
      if (reading) {
        const kind = gitRef[2] as "heads" | "tags";
        const name = gitRef[3]!.split("/").map(decodeURIComponent).join("/");
        const sha = (kind === "heads" ? branchesOf(repository) : tagsOf(repository)).get(name);
        if (!sha) return json(response, 404, { message: "Not Found" });
        return json(response, 200, { ref: `refs/${kind}/${name}`, object: { type: "commit", sha } });
      }
      if (gitRef[4]) {
        const body = JSON.parse(await readBody(request)) as { tag_name?: string; name?: string; body?: string };
        if (github.failingReleases.has(repository.fullName)) return json(response, 500, { message: "Server Error" });
        const tag = body.tag_name ?? "";
        if (!tagsOf(repository).has(tag)) return json(response, 422, { message: "Validation Failed: tag_name doesn't exist" });
        if (github.releasesCreated.some((r) => r.repository === repository.fullName && r.tag === tag)) {
          return json(response, 422, { message: "Validation Failed: already_exists" });
        }
        const url = `https://github.com/${repository.fullName}/releases/tag/${encodeURIComponent(tag)}`;
        github.releasesCreated.push({ repository: repository.fullName, tag, name: body.name ?? tag, body: body.body ?? "", url });
        return json(response, 201, { tag_name: tag, name: body.name, html_url: url });
      }
      const body = JSON.parse(await readBody(request)) as { ref?: string; sha?: string };
      const match = /^refs\/(heads|tags)\/(.+)$/.exec(body.ref ?? "");
      if (!match || !body.sha) return json(response, 422, { message: "Invalid request." });
      const refs = match[1] === "heads" ? branchesOf(repository) : tagsOf(repository);
      if (refs.has(match[2]!)) return json(response, 422, { message: "Reference already exists" });
      refs.set(match[2]!, body.sha);
      github.refsCreated.push({ repository: repository.fullName, ref: body.ref!, sha: body.sha });
      return json(response, 201, { ref: body.ref, object: { type: "commit", sha: body.sha } });
    }

    // API: an issue's Comments, oldest first, with a token of an installation that covers its repository and may read issues.
    const issueComments = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (request.method === "GET" && issueComments) {
      const issued = bearer ? installationTokens.get(bearer) : undefined;
      const installation = github.installations.find((i) => i.id === issued?.installationId);
      if (!issued || !installation || issued.expiresAt <= clock.now()) return json(response, 401, { message: "Bad credentials" });
      const repository = installation.repositories.find(
        (r) => r.fullName.toLowerCase() === decodeURIComponent(issueComments[1]!).toLowerCase(),
      );
      const issue = repository && github.issues.find((i) => i.repository === repository && i.number === Number(issueComments[2]));
      if (!repository || !issue || issue.commentsRefused) return json(response, 404, { message: "Not Found" });
      const access = installation.permissions.issues;
      if (access !== "read" && access !== "write") return json(response, 403, { message: "Resource not accessible by integration" });
      if (issuesLimit && clock.now() < issuesLimit.until) return rateLimited(response, issuesLimit);
      const { items, link } = page(url, issue.comments);
      return json(
        response,
        200,
        items.map((c) => ({
          body: c.body,
          created_at: c.createdAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
          user: accountJson(c.author),
        })),
        link ? { link } : {},
      );
    }

    // API: a repository's issues, Pull Requests among them, with a token of an installation that covers it and may read issues.
    const issues = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path);
    if (request.method === "GET" && issues) {
      const issued = bearer ? installationTokens.get(bearer) : undefined;
      const installation = github.installations.find((i) => i.id === issued?.installationId);
      if (!issued || !installation || issued.expiresAt <= clock.now()) return json(response, 401, { message: "Bad credentials" });
      const repository = installation.repositories.find((r) => r.fullName.toLowerCase() === decodeURIComponent(issues[1]!).toLowerCase());
      if (!repository) return json(response, 404, { message: "Not Found" });
      const access = installation.permissions.issues;
      if (access !== "read" && access !== "write") return json(response, 403, { message: "Resource not accessible by integration" });
      if (issuesLimit && !issuesLimit.only && clock.now() < issuesLimit.until) return rateLimited(response, issuesLimit);
      const state = url.searchParams.get("state") ?? "open";
      const listed = github.issues
        .filter((i) => i.repository === repository && (state === "all" || i.state === state))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.number - b.number);
      if (url.searchParams.get("direction") !== "asc") listed.reverse();
      const { items, link } = page(url, listed);
      return json(
        response,
        200,
        items.map((i) => ({
          node_id: i.nodeId,
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
          state_reason: i.stateReason,
          labels: i.labels.map((name) => ({ name, color: "ededed" })),
          html_url: `${github.url}/${repository.fullName}/${i.pullRequest ? "pull" : "issues"}/${i.number}`,
          created_at: i.createdAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
          user: accountJson(i.author),
          assignees: i.assignees.map(accountJson),
          ...(i.pullRequest ? { pull_request: { url: `${github.apiUrl}/repos/${repository.fullName}/pulls/${i.number}` } } : {}),
          sub_issues_summary: { total: github.issues.filter((s) => s.parent === i).length, completed: 0, percent_completed: 0 },
          issue_dependencies_summary: {
            blocked_by: i.blockedBy.filter((b) => b.state === "open").length,
            total_blocked_by: i.blockedBy.length,
            blocking: 0,
            total_blocking: github.issues.filter((b) => b.blockedBy.includes(i)).length,
          },
        })),
        link ? { link } : {},
      );
    }

    // API: an issue's sub-issues, or the issues it is blocked by, with a token of an installation that covers its
    // repository and may read issues.
    const linked = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/(sub_issues|dependencies\/blocked_by)$/.exec(path);
    if (request.method === "GET" && linked) {
      const asked = `${decodeURIComponent(linked[1]!)}#${linked[2]}/${linked[3]}`;
      github.linkRequests.push(asked);
      if (github.linksFail?.(asked)) return json(response, 502, { message: "Server Error" });
      const issued = bearer ? installationTokens.get(bearer) : undefined;
      const installation = github.installations.find((i) => i.id === issued?.installationId);
      if (!issued || !installation || issued.expiresAt <= clock.now()) return json(response, 401, { message: "Bad credentials" });
      const repository = installation.repositories.find((r) => r.fullName.toLowerCase() === decodeURIComponent(linked[1]!).toLowerCase());
      const issue = repository && github.issues.find((i) => i.repository === repository && i.number === Number(linked[2]));
      if (!repository || !issue) return json(response, 404, { message: "Not Found" });
      const access = installation.permissions.issues;
      if (access !== "read" && access !== "write") return json(response, 403, { message: "Resource not accessible by integration" });
      if (linksLimit && clock.now() < linksLimit.until) return rateLimited(response, linksLimit);
      const listed = linked[3] === "sub_issues" ? github.issues.filter((i) => i.parent === issue) : issue.blockedBy;
      const { items, link } = page(url, listed);
      return json(
        response,
        200,
        items.map((i) => ({
          node_id: i.nodeId,
          number: i.number,
          title: i.title,
          state: i.state,
          html_url: `${github.url}/${i.repository.fullName}/issues/${i.number}`,
          repository_url: `${github.apiUrl}/repos/${i.repository.fullName}`,
        })),
        link ? { link } : {},
      );
    }

    // API: a Pull Request, merging it and updating its branch, with a token of an installation that covers its repository.
    const pulls = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)(\/merge|\/update-branch)?$/.exec(path);
    if (pulls && ((request.method === "GET" && !pulls[3]) || (request.method === "PUT" && pulls[3]))) {
      const issued = bearer ? installationTokens.get(bearer) : undefined;
      const installation = github.installations.find((i) => i.id === issued?.installationId);
      if (!issued || !installation || issued.expiresAt <= clock.now()) return json(response, 401, { message: "Bad credentials" });
      const repository = installation.repositories.find((r) => r.fullName.toLowerCase() === decodeURIComponent(pulls[1]!).toLowerCase());
      const pullRequest = repository && pullRequests.get(`${repository.id}#${pulls[2]}`);
      if (!repository || !pullRequest) return json(response, 404, { message: "Not Found" });
      if (request.method === "GET") {
        const next = pullRequest.answers.length > 1 ? pullRequest.answers.shift()! : pullRequest.answers[0];
        const answer =
          next === undefined
            ? { mergeable: pullRequest.mergeable, baseSha: pullRequest.baseSha }
            : typeof next === "object" && next !== null
              ? next
              : { mergeable: next, baseSha: pullRequest.baseSha };
        const mergeable = pullRequest.state === "open" ? answer.mergeable : null;
        return json(response, 200, {
          number: pullRequest.number,
          state: pullRequest.state,
          draft: pullRequest.draft,
          merged: pullRequest.merged,
          mergeable,
          mergeable_state: mergeable === null ? "unknown" : !mergeable ? "dirty" : pullRequest.behind ? "behind" : "clean",
          head: { sha: pullRequest.headSha },
          base: { ref: pullRequest.base, sha: answer.baseSha },
        });
      }
      if (pulls[3] === "/update-branch") {
        const { expected_head_sha: expected } = JSON.parse((await readBody(request)) || "{}") as { expected_head_sha?: string };
        if (pullRequest.state !== "open") return json(response, 422, { message: "Pull Request is not open" });
        if (expected !== undefined && expected !== pullRequest.headSha) {
          return json(response, 422, { message: "expected head sha didn't match current head ref." });
        }
        if (pullRequest.mergeable === false) return json(response, 422, { message: "merge conflict between base and head" });
        const update = {
          repository: repository.fullName,
          number: pullRequest.number,
          from: pullRequest.headSha,
          to: `${pullRequest.headSha}u${github.updates.length + 1}`,
          installationId: installation.id,
        };
        pullRequest.headSha = update.to;
        pullRequest.behind = false;
        github.updates.push(update);
        await github.onUpdate?.(update);
        return json(response, 202, { message: "Updating pull request branch.", url: `${github.url}/${repository.fullName}/pull/${pullRequest.number}` });
      }
      const body = JSON.parse((await readBody(request)) || "{}") as { merge_method?: MergeMethod; sha?: string };
      const method = body.merge_method ?? "merge";
      if (!allows(repository, method)) {
        return json(response, 405, { message: `${method === "merge" ? "Merge commits are" : `${method} merges are`} not allowed on this repository.` });
      }
      if (pullRequest.state !== "open" || pullRequest.draft || pullRequest.mergeable !== true) {
        return json(response, 405, { message: "Pull Request is not mergeable" });
      }
      if (pullRequest.behind) return json(response, 405, { message: "Head branch is out of date" });
      if (body.sha !== undefined && body.sha !== pullRequest.headSha) {
        return json(response, 409, { message: "Head branch was modified. Review and try the merge again." });
      }
      pullRequest.state = "closed";
      pullRequest.merged = true;
      pullRequest.mergeCommit = `m${pullRequest.number}`;
      for (const other of pullRequest.conflicts) {
        other.mergeable = false;
        other.baseSha = pullRequest.mergeCommit;
      }
      const merge = { repository: repository.fullName, number: pullRequest.number, method, sha: body.sha ?? null, installationId: installation.id };
      github.merges.push(merge);
      await github.onMerge?.(merge);
      return json(response, 200, { sha: pullRequest.mergeCommit, merged: true, message: "Pull Request successfully merged" });
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
