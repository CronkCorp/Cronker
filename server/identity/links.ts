import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { hashSecret, issueSecret } from "./secrets.js";
import { userColumns, type User } from "./user.js";

/**
 * One-time links Cronk hands to an Admin (or an operator) to pass on: a **join** link
 * lets a User join a Workspace, setting their password if they have none yet or giving
 * it if they do, so nobody is joined without their say; a **reset** link sets a new
 * password. Each works once and for 7 days. The secret travels in the URL's fragment,
 * so it never reaches a server log; the web client posts it to the API.
 *
 * An Admin's reset link works only while every Workspace its User belongs to is one
 * the Admin is Admin of, checked when issued and again when used, so no Admin can
 * reach into a Workspace through a shared User (ADR 0002).
 */

export const linkLifetimeMs = 7 * 24 * 60 * 60 * 1000;

export type LinkKind = "join" | "reset";

export const Link = Type.Object({
  url: Type.String({ format: "uri" }),
  expiresAt: Type.String({ format: "date-time" }),
});
export type Link = Static<typeof Link>;

export const LinkDetails = Type.Object({
  kind: Type.Union([Type.Literal("join"), Type.Literal("reset")]),
  email: Type.Union([Type.String(), Type.Null()]),
  workspace: Type.Union([Type.Object({ id: Type.String(), name: Type.String() }), Type.Null()]),
  setsPassword: Type.Boolean(),
  /** A join link whose User signs in only with GitHub: they join by signing in with GitHub instead. */
  signInWithGitHub: Type.Boolean(),
});
export type LinkDetails = Static<typeof LinkDetails>;

export interface LinkOrigin {
  /** The Workspace a join link joins, or through which an Admin issued a reset link. */
  workspaceId: string;
  /** The Admin who issued a reset link. */
  issuedBy?: string;
}

/** Issues a link for the User. */
export async function issueLink(
  { config, clock }: Context,
  tx: Tx,
  kind: LinkKind,
  userId: string,
  origin?: LinkOrigin,
): Promise<Link> {
  const token = issueSecret(kind);
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + linkLifetimeMs);
  await tx.query(
    `insert into links (kind, user_id, workspace_id, issued_by, token_hash, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [kind, userId, origin?.workspaceId ?? null, origin?.issuedBy ?? null, hashSecret(token), now, expiresAt],
  );
  return { url: `${config.publicUrl.origin}/link#${token}`, expiresAt: expiresAt.toISOString() };
}

interface LinkRow {
  id: string;
  kind: LinkKind;
  user_id: string;
  email: string | null;
  password_hash: string | null;
  github_id: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  issued_by: string | null;
}

/**
 * Whether an Admin may reset the User's password: the User belongs to the Workspace
 * and every Workspace they belong to has the Admin as Admin.
 */
export async function adminReaches(tx: Tx, adminId: string, userId: string, workspaceId: string): Promise<boolean> {
  const { rows } = await tx.query<{ reaches: boolean }>(
    `select exists (select 1 from memberships where workspace_id = $3 and user_id = $2)
        and not exists (
          select 1 from memberships theirs
          where theirs.user_id = $2 and not exists (
            select 1 from memberships admins
            where admins.workspace_id = theirs.workspace_id and admins.user_id = $1 and admins.is_admin
          )
        ) as reaches`,
    [adminId, userId, workspaceId],
  );
  return rows[0]!.reaches;
}

/** Ends the User's unused reset links, once their password has changed. */
export async function endResetLinks(tx: Tx, userId: string): Promise<void> {
  await tx.query("delete from links where kind = 'reset' and user_id = $1 and used_at is null", [userId]);
}

async function findLink(tx: Tx, { clock }: Context, token: string, lock: boolean): Promise<LinkRow> {
  const { rows } = await tx.query<LinkRow>(
    `select links.id, links.kind, links.user_id, users.email, users.password_hash, users.github_id,
            links.workspace_id, workspaces.name as workspace_name, links.issued_by
     from links join users on users.id = links.user_id
     left join workspaces on workspaces.id = links.workspace_id
     where links.token_hash = $1 and links.used_at is null and links.expires_at > $2
     ${lock ? "for update of links" : ""}`,
    [hashSecret(token.trim()), clock.now()],
  );
  const link = rows[0];
  const reachable =
    link && (link.kind !== "reset" || !link.issued_by || (await adminReaches(tx, link.issued_by, link.user_id, link.workspace_id!)));
  if (!link || !reachable) {
    throw new ApiError(404, "invalid_link", "That link has been used, has expired or never existed.");
  }
  return link;
}

/**
 * A join link can't set the password of a User who signs in only with GitHub: whoever holds
 * the link could take over their sign-in. They join by signing in with GitHub instead.
 */
function joinsWithGitHub(link: LinkRow): boolean {
  return link.kind === "join" && link.password_hash === null && link.github_id !== null;
}

/** What a link would do, so its page can say so before it is used. */
export async function lookUpLink(context: Context, token: string): Promise<LinkDetails> {
  return transaction(context.db, async (tx) => {
    const link = await findLink(tx, context, token, false);
    return {
      kind: link.kind,
      email: link.email,
      workspace: link.workspace_id ? { id: link.workspace_id, name: link.workspace_name! } : null,
      setsPassword: link.kind === "reset" || (link.password_hash === null && link.github_id === null),
      signInWithGitHub: joinsWithGitHub(link),
    };
  });
}

/**
 * Uses a link once. A reset link sets the password and ends the User's sign-ins and
 * other reset links. A join link makes the User a member, setting their password if
 * they have none yet, or needing it if they do.
 */
export async function useLink(context: Context, token: string, password: string): Promise<User> {
  const passwordHash = await hashPassword(password);
  return transaction(context.db, async (tx) => {
    const link = await findLink(tx, context, token, true);
    const now = context.clock.now();
    if (joinsWithGitHub(link)) {
      throw new ApiError(409, "sign_in_with_github", "This User signs in with GitHub. Sign in with GitHub to join.");
    }
    if (link.kind === "reset" || link.password_hash === null) {
      await tx.query("update users set password_hash = $1 where id = $2", [passwordHash, link.user_id]);
    } else if (!(await verifyPassword(password, link.password_hash))) {
      throw new ApiError(403, "wrong_password", `That isn't the password of ${link.email}.`);
    }
    if (link.kind === "reset") {
      await tx.query("delete from sign_ins where user_id = $1", [link.user_id]);
      context.live.endAfterCommit(tx, (stream) => stream.userId === link.user_id);
      await endResetLinks(tx, link.user_id);
    } else {
      await tx.query(
        `insert into memberships (workspace_id, user_id, is_admin, created_at) values ($1, $2, false, $3)
         on conflict do nothing`,
        [link.workspace_id, link.user_id, now],
      );
    }
    await tx.query("update links set used_at = $1 where id = $2", [now, link.id]);
    const { rows } = await tx.query<User>(`select ${userColumns} from users where id = $1`, [link.user_id]);
    return rows[0]!;
  });
}

/** A reset link for whichever User has the email, for an operator when nobody can sign in. */
export async function issueResetLinkByEmail(context: Context, email: string): Promise<{ user: User; link: Link }> {
  return transaction(context.db, async (tx) => {
    const { rows } = await tx.query<User>(`select ${userColumns} from users where lower(email) = lower($1)`, [email.trim()]);
    const user = rows[0];
    if (!user) throw new ApiError(404, "not_found", `No User has the email ${email.trim()}.`);
    return { user, link: await issueLink(context, tx, "reset", user.id) };
  });
}
