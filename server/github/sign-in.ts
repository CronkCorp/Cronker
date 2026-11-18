import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { issueSecret } from "../identity/secrets.js";
import { startSignIn } from "../identity/sign-ins.js";
import { appCredentials, callbackPath, githubNotSetUp } from "./app.js";
import { exchangeCode, under, userOf, type GitHubUser } from "./client.js";

/**
 * Signing in with GitHub: Cronk sends the browser to GitHub to authorize the App, GitHub
 * sends it back with a code, and Cronk trades the code for the GitHub account it belongs to.
 *
 * The account signs in as the User it is linked to. An account not linked yet is linked
 * to the User whose email is the account's verified primary email, if that User has no
 * GitHub account yet. Any other account is refused: a User exists only once added.
 *
 * The OAuth state travels in a short-lived `SameSite=Lax` cookie as well as through
 * GitHub, so a sign-in can only finish in the browser that started it.
 */

const stateCookie = "cronk_github_state";
const stateLifetimeSeconds = 10 * 60;


function callbackUrl({ config }: Context): string {
  return `${config.publicUrl.origin}${callbackPath}`;
}

/** Where to send the browser to authorize the App, having set the state cookie. */
export async function beginSignIn(context: Context, reply: FastifyReply): Promise<string> {
  const app = await appCredentials(context);
  if (!app) throw githubNotSetUp();
  const state = issueSecret("github_sign_in");
  reply.setCookie(stateCookie, state, {
    path: callbackPath,
    httpOnly: true,
    // GitHub's redirect back is a cross-site navigation, which carries Lax cookies but not Strict ones.
    sameSite: "lax",
    secure: context.config.publicUrl.protocol === "https:",
    maxAge: stateLifetimeSeconds,
  });
  const url = under(context.config.github.url, "/login/oauth/authorize");
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(context));
  url.searchParams.set("state", state);
  return url.toString();
}

function sameState(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface Callback {
  code?: string;
  state?: string;
  error?: string;
}

/** Finishes a sign-in GitHub sent the browser back from, signing the User in. */
export async function finishSignIn(
  context: Context,
  request: FastifyRequest,
  reply: FastifyReply,
  { code, state, error }: Callback,
): Promise<void> {
  const expected = request.cookies[stateCookie];
  reply.clearCookie(stateCookie, { path: callbackPath });
  if (!expected || !state || !sameState(expected, state)) {
    throw new ApiError(400, "invalid_state", "That sign-in with GitHub didn't start in this browser, or took too long.");
  }
  if (error || !code) throw new ApiError(403, "github_denied", "GitHub didn't sign you in.");

  const app = await appCredentials(context);
  if (!app) throw githubNotSetUp();
  const token = await exchangeCode(context.config, app, code, callbackUrl(context));
  if (!token) throw new ApiError(403, "github_denied", "GitHub didn't accept the sign-in. Try again.");
  const account = await userOf(context.config, token);
  const userId = await transaction(context.db, async (tx) => {
    const id = await userFor(tx, account);
    await joinWhereAdded(tx, context.clock.now(), id);
    return id;
  });
  await startSignIn(context, reply, userId);
}

/** The User the GitHub account signs in as, linking it if it isn't yet; refused if there is none. */
async function userFor(tx: Tx, account: GitHubUser): Promise<string> {
  const linked = await tx.query<{ id: string }>(
    "update users set github_login = $2 where github_id = $1 returning id",
    [account.id, account.login],
  );
  const id = linked.rows[0]?.id;
  if (id && account.verifiedEmail) {
    const existing = await tx.query<{ id: string }>(
      "select id from users where lower(email) = lower($1) and github_id is null",
      [account.verifiedEmail],
    );
    const byEmail = existing.rows[0];
    if (byEmail && (await isPlaceholder(tx, id))) return mergeInto(tx, id, byEmail.id, account);
    // A User added by GitHub login learns their email at their first sign-in, unless another User has it.
    await tx.query(
      `update users set email = $2 where id = $1 and email is null
       and not exists (select 1 from users other where lower(other.email) = lower($2))`,
      [id, account.verifiedEmail],
    );
  }
  if (id) return id;

  if (account.verifiedEmail) {
    const byEmail = await tx.query<{ id: string }>(
      `update users set github_id = $1, github_login = $2
       where lower(email) = lower($3) and github_id is null returning id`,
      [account.id, account.login, account.verifiedEmail],
    );
    if (byEmail.rows[0]) return byEmail.rows[0].id;
  }

  throw new ApiError(
    403,
    "unknown_github_user",
    `No User has the GitHub account ${account.login}. Ask an Admin to add you to their Workspace.`,
  );
}

/** Whether the User is only what adding by GitHub login made: no email, no password, in no Workspace yet. */
async function isPlaceholder(tx: Tx, userId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    `select 1 from users where id = $1 and email is null and password_hash is null
     and not exists (select 1 from memberships where user_id = $1)`,
    [userId],
  );
  return rowCount !== 0;
}

/**
 * Someone added by GitHub login who already had a User by email is one person: their
 * Workspaces to join move to that User, which takes the GitHub account, and the
 * placeholder goes.
 */
async function mergeInto(tx: Tx, placeholderId: string, userId: string, account: GitHubUser): Promise<string> {
  await tx.query(
    `insert into github_joins (workspace_id, user_id, added_by, created_at)
     select workspace_id, $2, added_by, created_at from github_joins where user_id = $1
     on conflict do nothing`,
    [placeholderId, userId],
  );
  await tx.query("delete from github_joins where user_id = $1", [placeholderId]);
  await tx.query("delete from sign_ins where user_id = $1", [placeholderId]);
  await tx.query("delete from users where id = $1", [placeholderId]);
  await tx.query("update users set github_id = $2, github_login = $3 where id = $1", [userId, account.id, account.login]);
  return userId;
}

/**
 * Joins the User to every Workspace an Admin added them to and they haven't joined: by
 * GitHub login, or by email with a join link not used yet, since signing in with the
 * GitHub account of that email shows it is theirs as well as the link would.
 */
async function joinWhereAdded(tx: Tx, now: Date, userId: string): Promise<void> {
  const links = await tx.query<{ workspace_id: string }>(
    `update links set used_at = $2 where kind = 'join' and user_id = $1 and used_at is null and expires_at > $2
     returning workspace_id`,
    [userId, now],
  );
  const joins = await tx.query<{ workspace_id: string }>(
    "delete from github_joins where user_id = $1 returning workspace_id",
    [userId],
  );
  for (const { workspace_id } of [...links.rows, ...joins.rows]) {
    await tx.query(
      `insert into memberships (workspace_id, user_id, is_admin, created_at) values ($1, $2, false, $3)
       on conflict do nothing`,
      [workspace_id, userId, now],
    );
  }
}
