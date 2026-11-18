import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { adminReaches, issueLink, Link } from "../identity/links.js";
import { User, type User as UserRecord } from "../identity/user.js";
import { findWorkspace, type Workspace } from "./workspaces.js";

export const Member = Type.Object({ user: User, isAdmin: Type.Boolean() });
export type Member = Static<typeof Member>;

export const AddedMember = Type.Object({ user: User, link: Link });
export type AddedMember = Static<typeof AddedMember>;

const notFound = () => new ApiError(404, "not_found", "No such Workspace.");

/** The Workspace and whether the User is its Admin; 404 if they don't belong to it. */
export async function requireMember(db: Db, userId: string, workspaceId: string): Promise<Workspace & { isAdmin: boolean }> {
  const workspace = await findWorkspace(db, userId, workspaceId);
  if (!workspace) throw notFound();
  const { rows } = await db.query<{ is_admin: boolean }>(
    "select is_admin from memberships where workspace_id = $1 and user_id = $2",
    [workspace.id, userId],
  );
  return { ...workspace, isAdmin: rows[0]?.is_admin ?? false };
}

/** The Workspace, if the User is its Admin: 404 if they don't belong to it, 403 if they aren't its Admin. */
export async function requireAdmin(db: Db, userId: string, workspaceId: string): Promise<Workspace> {
  const { isAdmin, ...workspace } = await requireMember(db, userId, workspaceId);
  if (!isAdmin) throw new ApiError(403, "not_admin", "Only an Admin of this Workspace can do that.");
  return workspace;
}

export async function membersOf(db: Db, workspaceId: string): Promise<Member[]> {
  const { rows } = await db.query<{ id: string; email: string; is_admin: boolean }>(
    `select users.id, users.email, memberships.is_admin
     from memberships join users on users.id = memberships.user_id
     where memberships.workspace_id = $1 order by memberships.created_at, lower(users.email)`,
    [workspaceId],
  );
  return rows.map((r) => ({ user: { id: r.id, email: r.email }, isAdmin: r.is_admin }));
}

/**
 * Adds a User to the Workspace by email, creating them without a password if no User
 * has it. They get a one-time join link either way, so nobody joins without their say.
 */
export async function addMember(context: Context, workspaceId: string, email: string): Promise<AddedMember> {
  return transaction(context.db, async (tx) => {
    await tx.query("insert into users (email, created_at) values ($1, $2) on conflict do nothing", [
      email,
      context.clock.now(),
    ]);
    const { rows } = await tx.query<UserRecord>("select id, email from users where lower(email) = lower($1)", [email]);
    const user = rows[0]!;
    const isMember = await tx.query("select 1 from memberships where workspace_id = $1 and user_id = $2", [
      workspaceId,
      user.id,
    ]);
    if (isMember.rowCount) throw new ApiError(409, "already_member", `${user.email} already belongs to this Workspace.`);
    return { user, link: await issueLink(context, tx, "join", user.id, { workspaceId }) };
  });
}

async function lockMembers(tx: Tx, workspaceId: string) {
  const { rows } = await tx.query<{ user_id: string; is_admin: boolean }>(
    "select user_id, is_admin from memberships where workspace_id = $1 for update",
    [workspaceId],
  );
  return rows;
}

const memberNotFound = () => new ApiError(404, "not_found", "No such member of this Workspace.");
const lastAdmin = () =>
  new ApiError(409, "last_admin", "A Workspace can't be left without an Admin. Make another member Admin first.");

/** Makes a member Admin or not; refused if it would leave the Workspace without an Admin. */
export async function setAdmin(db: Db, workspaceId: string, userId: string, isAdmin: boolean): Promise<Member> {
  return transaction(db, async (tx) => {
    const members = await lockMembers(tx, workspaceId);
    const member = members.find((m) => m.user_id === userId);
    if (!member) throw memberNotFound();
    if (!isAdmin && member.is_admin && members.filter((m) => m.is_admin).length === 1) throw lastAdmin();
    await tx.query("update memberships set is_admin = $1 where workspace_id = $2 and user_id = $3", [
      isAdmin,
      workspaceId,
      userId,
    ]);
    const { rows } = await tx.query<UserRecord>("select id, email from users where id = $1", [userId]);
    return { user: rows[0]!, isAdmin };
  });
}

/**
 * Removes a member, who then sees nothing of the Workspace. Their unused links to join
 * it end too. Refused if it would leave the Workspace without an Admin.
 */
export async function removeMember(db: Db, workspaceId: string, userId: string): Promise<void> {
  await transaction(db, async (tx) => {
    const members = await lockMembers(tx, workspaceId);
    const member = members.find((m) => m.user_id === userId);
    if (!member) throw memberNotFound();
    if (member.is_admin && members.filter((m) => m.is_admin).length === 1) throw lastAdmin();
    await tx.query("delete from memberships where workspace_id = $1 and user_id = $2", [workspaceId, userId]);
    await tx.query(
      "delete from links where kind = 'join' and workspace_id = $1 and user_id = $2 and used_at is null",
      [workspaceId, userId],
    );
  });
}

/**
 * A one-time link for a member to set a new password, for an Admin to pass on. Refused
 * if the member also belongs to a Workspace the Admin isn't Admin of.
 */
export async function issueResetLink(context: Context, adminId: string, workspaceId: string, userId: string): Promise<Link> {
  return transaction(context.db, async (tx) => {
    const members = await lockMembers(tx, workspaceId);
    if (!members.some((m) => m.user_id === userId)) throw memberNotFound();
    if (!(await adminReaches(tx, adminId, userId, workspaceId))) {
      throw new ApiError(
        409,
        "member_elsewhere",
        "This member also belongs to a Workspace you aren't Admin of. They can change their password themselves, or whoever runs Cronk can issue a reset link with the server command.",
      );
    }
    return issueLink(context, tx, "reset", userId, { workspaceId, issuedBy: adminId });
  });
}
