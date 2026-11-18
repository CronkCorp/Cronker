import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { startSignIn } from "../identity/sign-ins.js";
import { appCredentials, callbackPath } from "./app.js";
import { exchangeCode, userOf, type GitHubUser } from "./client.js";

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

const notSetUp = () =>
  new ApiError(404, "github_not_set_up", "This installation has no GitHub App, so nobody can sign in with GitHub yet.");

function callbackUrl({ config }: Context): string {
  return `${config.publicUrl.origin}${callbackPath}`;
}

/** Where to send the browser to authorize the App, having set the state cookie. */
export async function beginSignIn(context: Context, reply: FastifyReply): Promise<string> {
  const app = await appCredentials(context);
  if (!app) throw notSetUp();
  const state = randomBytes(32).toString("base64url");
  reply.setCookie(stateCookie, state, {
    path: callbackPath,
    httpOnly: true,
    // GitHub's redirect back is a cross-site navigation, which carries Lax cookies but not Strict ones.
    sameSite: "lax",
    secure: context.config.publicUrl.protocol === "https:",
    maxAge: stateLifetimeSeconds,
  });
  const url = new URL(`${context.config.github.url.href.replace(/\/$/, "")}/login/oauth/authorize`);
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
  if (!app) throw notSetUp();
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
  if (linked.rows[0]) {
    // A User added by GitHub login learns their email at their first sign-in, unless another User has it.
    if (account.verifiedEmail) {
      await tx.query(
        `update users set email = $2 where id = $1 and email is null
         and not exists (select 1 from users other where lower(other.email) = lower($2))`,
        [linked.rows[0].id, account.verifiedEmail],
      );
    }
    return linked.rows[0].id;
  }

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
