import { Type, type Static } from "typebox";

/** Whoever performed an action: a User, or (later) an Agent. */
export const Actor = Type.Object({
  kind: Type.Literal("user"),
  id: Type.String({ format: "uuid" }),
  name: Type.String({ description: "How to show the Actor: a User's email." }),
});
export type Actor = Static<typeof Actor>;

/** Selects a User as an Actor, from `users` joined as the given alias. */
export const actorColumn = (users: string) =>
  `json_build_object('kind', 'user', 'id', ${users}.id, 'name', ${users}.email)`;
