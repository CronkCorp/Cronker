import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { transaction } from "../db.js";
import { endResetLinks } from "./links.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { hashSecret, issueSecret } from "./secrets.js";
import type { User } from "./user.js";

/** A sign-in lasts 30 days from when the User signed in. */
export const signInLifetimeSeconds = 30 * 24 * 60 * 60;
export const signInCookie = "cronk_sign_in";

// Hashed once so that an unknown email costs as much as a wrong password.
const decoyPasswordHash =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function signIn(
  { db, clock, config }: Context,
  reply: FastifyReply,
  email: string,
  password: string,
): Promise<User> {
  const { rows } = await db.query<{ id: string; email: string; password_hash: string | null }>(
    "select id, email, password_hash from users where lower(email) = lower($1)",
    [email],
  );
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? decoyPasswordHash);
  if (!user || !user.password_hash || !ok) {
    throw new ApiError(401, "invalid_credentials", "That email and password don't match a User.");
  }

  const token = issueSecret("sign_in");
  const now = clock.now();
  // Expired sign-ins are no use to anyone; drop the User's while adding a new one.
  await db.query("delete from sign_ins where user_id = $1 and expires_at <= $2", [user.id, now]);
  await db.query("insert into sign_ins (user_id, token_hash, created_at, expires_at) values ($1, $2, $3, $4)", [
    user.id,
    hashSecret(token),
    now,
    new Date(now.getTime() + signInLifetimeSeconds * 1000),
  ]);
  reply.setCookie(signInCookie, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.publicUrl.protocol === "https:",
    maxAge: signInLifetimeSeconds,
  });
  return { id: user.id, email: user.email };
}

/** Ends the request's sign-in, and the event streams opened with it. */
export async function signOut({ db, live }: Context, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[signInCookie];
  if (token) {
    const hash = hashSecret(token);
    await db.query("delete from sign_ins where token_hash = $1", [hash]);
    live.end((stream) => stream.signIn === hash);
  }
  reply.clearCookie(signInCookie, { path: "/" });
}

/** The User the request's sign-in cookie belongs to, or a 401 refusal. */
export async function requireUser({ db, clock }: Context, request: FastifyRequest): Promise<User> {
  const token = request.cookies[signInCookie];
  if (token) {
    const { rows } = await db.query<User>(
      `select users.id, users.email from sign_ins join users on users.id = sign_ins.user_id
       where sign_ins.token_hash = $1 and sign_ins.expires_at > $2`,
      [hashSecret(token), clock.now()],
    );
    if (rows[0]) return rows[0];
  }
  throw new ApiError(401, "not_signed_in", "Sign in first.");
}

/**
 * Changes the signed-in User's own password, given their current one, and ends every
 * other sign-in and unused reset link of theirs; the one making the change stays signed in.
 */
export async function changePassword(
  context: Context,
  request: FastifyRequest,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await requireUser(context, request);
  const newHash = await hashPassword(newPassword);
  const { rows } = await context.db.query<{ password_hash: string | null }>(
    "select password_hash from users where id = $1",
    [user.id],
  );
  const current = rows[0]?.password_hash;
  if (!current || !(await verifyPassword(currentPassword, current))) {
    throw new ApiError(403, "wrong_password", "That isn't your current password.");
  }
  const thisSignIn = hashSecret(request.cookies[signInCookie] ?? "");
  await transaction(context.db, async (tx) => {
    await tx.query("update users set password_hash = $1 where id = $2", [newHash, user.id]);
    await tx.query("delete from sign_ins where user_id = $1 and token_hash <> $2", [user.id, thisSignIn]);
    context.live.endAfterCommit(tx, (stream) => stream.userId === user.id && stream.signIn !== thisSignIn);
    await endResetLinks(tx, user.id);
  });
}
