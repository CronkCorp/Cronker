import { Type, type Static } from "typebox";

export const User = Type.Object({
  id: Type.String({ format: "uuid" }),
  /** Unknown (`null`) for a User added by GitHub login until they first sign in with GitHub. */
  email: Type.Union([Type.String(), Type.Null()]),
  /** The login of the User's GitHub account, once linked. */
  githubLogin: Type.Union([Type.String(), Type.Null()]),
  /** The name the User chose to be shown by, in place of their email or GitHub login; `null` when they chose none. */
  displayName: Type.Union([Type.String(), Type.Null()]),
});
export type User = Static<typeof User>;

/** The columns of `users` that make a `User`, for `select … from users`. */
export const userColumns = `users.id, users.email, users.github_login as "githubLogin", users.display_name as "displayName"`;

/**
 * How Cronk names the User in `users` joined as the given alias: their display name, else their email, else
 * their GitHub login (as `@login`) until their email is known. Sign-in never goes by it.
 */
export const userName = (users = "users") =>
  `coalesce(${users}.display_name, ${users}.email, '@' || ${users}.github_login)`;

/** A User as JSON, for a User nested in another row, from `users` joined as the given alias. */
export const userJson = (users: string) =>
  `json_build_object('id', ${users}.id, 'email', ${users}.email, 'githubLogin', ${users}.github_login, 'displayName', ${users}.display_name)`;

/** How to name a User in text Cronk writes, as `userName` does in SQL. */
export const userNameOf = (user: User): string => user.displayName ?? user.email ?? `@${user.githubLogin}`;

export const DisplayName = Type.String({
  maxLength: 80,
  description: "At most 80 characters, without line breaks; trimmed, and an empty one clears it.",
});

export const Email = Type.String({ format: "email", maxLength: 320 });
export const Password = Type.String({ minLength: 8, maxLength: 1024 });
