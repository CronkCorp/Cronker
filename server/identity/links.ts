import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { hashPassword } from "./passwords.js";
import { hashSecret, issueSecret } from "./secrets.js";
import type { User } from "./user.js";

/**
 * One-time links Cronk hands to an Admin (or an operator) to pass on: a **join** link
 * lets someone set their password and join a Workspace, a **reset** link sets a new
 * password. Each works once and for 7 days. The secret travels in the URL's fragment,
 * so it never reaches a server log; the web client posts it to the API.
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
  email: Type.String(),
  workspace: Type.Union([Type.Object({ id: Type.String(), name: Type.String() }), Type.Null()]),
  needsPassword: Type.Boolean(),
});
export type LinkDetails = Static<typeof LinkDetails>;

/** Issues a link for the User; a join link also names the Workspace it joins. */
export async function issueLink(
  { config, clock }: Context,
  tx: Tx,
  kind: LinkKind,
  userId: string,
  workspaceId: string | null = null,
): Promise<Link> {
  const token = issueSecret(kind);
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + linkLifetimeMs);
  await tx.query(
    `insert into links (kind, user_id, workspace_id, token_hash, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [kind, userId, workspaceId, hashSecret(token), now, expiresAt],
  );
  return { url: `${config.publicUrl.origin}/link#${token}`, expiresAt: expiresAt.toISOString() };
}

interface LinkRow {
  id: string;
  kind: LinkKind;
  user_id: string;
  email: string;
  password_hash: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
}

async function findLink(tx: Tx, { clock }: Context, token: string, lock: boolean): Promise<LinkRow> {
  const { rows } = await tx.query<LinkRow>(
    `select links.id, links.kind, links.user_id, users.email, users.password_hash,
            links.workspace_id, workspaces.name as workspace_name
     from links join users on users.id = links.user_id
     left join workspaces on workspaces.id = links.workspace_id
     where links.token_hash = $1 and links.used_at is null and links.expires_at > $2
     ${lock ? "for update of links" : ""}`,
    [hashSecret(token.trim()), clock.now()],
  );
  if (!rows[0]) throw new ApiError(404, "invalid_link", "That link has been used, has expired or never existed.");
  return rows[0];
}

/** What a link would do, so its page can say so before it is used. */
export async function lookUpLink(context: Context, token: string): Promise<LinkDetails> {
  return transaction(context.db, async (tx) => {
    const link = await findLink(tx, context, token, false);
    return {
      kind: link.kind,
      email: link.email,
      workspace: link.workspace_id ? { id: link.workspace_id, name: link.workspace_name! } : null,
      needsPassword: link.kind === "reset" || link.password_hash === null,
    };
  });
}

/**
 * Uses a link once. A reset link sets the password and ends the User's sign-ins. A join
 * link sets the password if the User has none yet, and makes them a member.
 */
export async function useLink(context: Context, token: string, password: string | undefined): Promise<User> {
  const passwordHash = password === undefined ? undefined : await hashPassword(password);
  return transaction(context.db, async (tx) => {
    const link = await findLink(tx, context, token, true);
    const now = context.clock.now();
    const setsPassword = link.kind === "reset" || link.password_hash === null;
    if (setsPassword) {
      if (!passwordHash) throw new ApiError(400, "password_needed", "Choose a password to use this link.");
      await tx.query("update users set password_hash = $1 where id = $2", [passwordHash, link.user_id]);
    }
    if (link.kind === "reset") await tx.query("delete from sign_ins where user_id = $1", [link.user_id]);
    if (link.kind === "join") {
      await tx.query(
        `insert into memberships (workspace_id, user_id, is_admin, created_at) values ($1, $2, false, $3)
         on conflict do nothing`,
        [link.workspace_id, link.user_id, now],
      );
    }
    await tx.query("update links set used_at = $1 where id = $2", [now, link.id]);
    return { id: link.user_id, email: link.email };
  });
}
