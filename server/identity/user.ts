import { Type, type Static } from "typebox";

export const User = Type.Object({
  id: Type.String({ format: "uuid" }),
  /** Unknown (`null`) for a User added by GitHub login until they first sign in with GitHub. */
  email: Type.Union([Type.String(), Type.Null()]),
  /** The login of the User's GitHub account, once linked. */
  githubLogin: Type.Union([Type.String(), Type.Null()]),
});
export type User = Static<typeof User>;

/** The columns of `users` that make a `User`, for `select … from users`. */
export const userColumns = `users.id, users.email, users.github_login as "githubLogin"`;

export const Email = Type.String({ format: "email", maxLength: 320 });
export const Password = Type.String({ minLength: 8, maxLength: 1024 });
