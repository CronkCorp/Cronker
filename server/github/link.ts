import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { transaction } from "../db.js";
import { ApiError } from "../http/errors.js";
import { hashSecret, issueSecret } from "../identity/secrets.js";
import type { User } from "../identity/user.js";
import type { GitHubUser } from "./client.js";
import { accountFor, authorize, codeOf, isPlaceholder, joinWhereAddedByLogin, mergeInto, stateLifetimeSeconds, type Callback } from "./sign-in.js";

/**
 * Linking a GitHub account to a signed-in User who has none, such as one who signs in with
 * a password: the same authorization as signing in with GitHub, through the same callback,
 * which the GitHub App registers alone. Once linked, the account signs in as the User and
 * its merges count as the User's own.
 *
 * GitHub's redirect back carries no `SameSite=Strict` sign-in cookie, so the User who
 * started the link is kept with the state, by its hash: the callback links the account to
 * that User only, and only in the browser holding the state cookie.
 */

const statePrefix = "cronk_github_link_";

/** Whether a callback's state is a link's rather than a sign-in's. */
export function isLinkState(state: string | undefined): boolean {
  return state?.startsWith(statePrefix) === true;
}

function alreadyLinked(login: string | null): ApiError {
  return new ApiError(409, "github_already_linked", `You already have a GitHub account linked${login ? `: ${login}` : ""}.`);
}

/** Where to send the User's browser to authorize the App and link the account it signs in to GitHub as. */
export async function beginLink(context: Context, reply: FastifyReply, user: User): Promise<string> {
  if (user.githubLogin !== null) throw alreadyLinked(user.githubLogin);
  const state = issueSecret("github_link");
  const now = context.clock.now();
  const url = await authorize(context, reply, state);
  await context.db.query("insert into github_link_states (token_hash, user_id, created_at, expires_at) values ($1, $2, $3, $4)", [
    hashSecret(state),
    user.id,
    now,
    new Date(now.getTime() + stateLifetimeSeconds * 1000),
  ]);
  return url;
}

/** Finishes a link GitHub sent the browser back from: links the account to the User who started it. */
export async function finishLink(context: Context, request: FastifyRequest, reply: FastifyReply, callback: Callback): Promise<void> {
  const code = codeOf(request, reply, callback);
  const { rows } = await context.db.query<{ user_id: string; live: boolean }>(
    "delete from github_link_states where token_hash = $1 returning user_id, expires_at > $2 as live",
    [hashSecret(callback.state!), context.clock.now()],
  );
  const started = rows[0];
  if (!started?.live) throw new ApiError(400, "invalid_state", "That link to GitHub has expired, was used or never started.");
  const account = await accountFor(context, code);
  await link(context, started.user_id, account);
}

async function link(context: Context, userId: string, account: GitHubUser): Promise<void> {
  await transaction(context.db, async (tx) => {
    const me = await tx.query<{ github_id: string | null; github_login: string | null }>(
      "select github_id, github_login from users where id = $1 for update",
      [userId],
    );
    const mine = me.rows[0];
    if (!mine) throw new ApiError(400, "invalid_state", "That link to GitHub has expired, was used or never started.");
    if (mine.github_id !== null) {
      if (Number(mine.github_id) !== account.id) throw alreadyLinked(mine.github_login);
      await tx.query("update users set github_login = $2 where id = $1", [userId, account.login]);
      return;
    }

    const other = await tx.query<{ id: string }>("select id from users where github_id = $1 for update", [account.id]);
    const holder = other.rows[0];
    if (holder) {
      // Someone an Admin added by this GitHub login who never signed in is the User linking it: one person.
      if (!(await isPlaceholder(tx, holder.id))) {
        throw new ApiError(409, "github_account_taken", `The GitHub account ${account.login} is linked to another User.`);
      }
      await mergeInto(tx, holder.id, userId, account);
    } else {
      await tx.query("update users set github_id = $2, github_login = $3 where id = $1 and github_id is null", [
        userId,
        account.id,
        account.login,
      ]);
    }
    await joinWhereAddedByLogin(tx, context.clock.now(), userId);
  });
}
