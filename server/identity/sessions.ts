import type { FastifyReply, FastifyRequest } from "fastify";
import type { Context } from "../context.js";
import { ApiError } from "../http/errors.js";
import { verifyPassword } from "./passwords.js";
import { hashSecret, issueSecret } from "./secrets.js";

/** A sign-in lasts 30 days from when the User signed in. */
export const sessionLifetimeSeconds = 30 * 24 * 60 * 60;
export const sessionCookie = "cronk_session";

export interface SignedInUser {
  id: string;
  email: string;
}

// Hashed once so that an unknown email costs as much as a wrong password.
const decoyPasswordHash =
  "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function signIn(
  { db, clock, config }: Context,
  reply: FastifyReply,
  email: string,
  password: string,
): Promise<SignedInUser> {
  const { rows } = await db.query<{ id: string; email: string; password_hash: string | null }>(
    "select id, email, password_hash from users where lower(email) = lower($1)",
    [email.trim()],
  );
  const user = rows[0];
  const ok = await verifyPassword(password, user?.password_hash ?? decoyPasswordHash);
  if (!user || !user.password_hash || !ok) {
    throw new ApiError(401, "invalid_credentials", "That email and password don't match a User.");
  }

  const token = issueSecret("session");
  const now = clock.now();
  await db.query("insert into sessions (user_id, token_hash, created_at, expires_at) values ($1, $2, $3, $4)", [
    user.id,
    hashSecret(token),
    now,
    new Date(now.getTime() + sessionLifetimeSeconds * 1000),
  ]);
  reply.setCookie(sessionCookie, token, {
    path: "/",
    httpOnly: true,
    sameSite: "strict",
    secure: config.publicUrl.protocol === "https:",
    maxAge: sessionLifetimeSeconds,
  });
  return { id: user.id, email: user.email };
}

export async function signOut({ db }: Context, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = request.cookies[sessionCookie];
  if (token) await db.query("delete from sessions where token_hash = $1", [hashSecret(token)]);
  reply.clearCookie(sessionCookie, { path: "/" });
}

/** The User the request's sign-in cookie belongs to, or a 401 refusal. */
export async function requireUser({ db, clock }: Context, request: FastifyRequest): Promise<SignedInUser> {
  const token = request.cookies[sessionCookie];
  if (token) {
    const { rows } = await db.query<SignedInUser>(
      `select users.id, users.email from sessions join users on users.id = sessions.user_id
       where sessions.token_hash = $1 and sessions.expires_at > $2`,
      [hashSecret(token), clock.now()],
    );
    if (rows[0]) return rows[0];
  }
  throw new ApiError(401, "not_signed_in", "Sign in first.");
}
