import { Type, type Static } from "typebox";

/** Whoever performed an action: a User or an Agent. */
export const Actor = Type.Object({
  kind: Type.Union([Type.Literal("user"), Type.Literal("agent")]),
  id: Type.String({ format: "uuid" }),
  name: Type.String({ description: "How to show the Actor: a User's email, or an Agent's name." }),
});
export type Actor = Static<typeof Actor>;

/**
 * Selects an Actor from `users` joined as the given alias, or, given an alias `agents`
 * is joined as, from whichever of the two is there.
 */
export const actorColumn = (users: string, agents?: string) => {
  const user = `json_build_object('kind', 'user', 'id', ${users}.id, 'name', ${users}.email)`;
  if (!agents) return user;
  return `case when ${agents}.id is null then ${user}
    else json_build_object('kind', 'agent', 'id', ${agents}.id, 'name', ${agents}.name) end`;
};

/** Whoever performed an action, or Cronk itself, such as when it moves a Ticket on past a skipped Step. */
export const ActorOrCronk = Type.Union([
  Actor,
  Type.Object({ kind: Type.Literal("cronk"), name: Type.Literal("Cronk") }, { description: "Cronk itself." }),
]);
export type ActorOrCronk = Static<typeof ActorOrCronk>;

/** Selects an Actor as `actorColumn` does from `users` and `agents` joined as the given aliases, or Cronk where neither is there. */
export const actorOrCronkColumn = (users: string, agents: string) =>
  `case when ${users}.id is null and ${agents}.id is null then json_build_object('kind', 'cronk', 'name', 'Cronk')
    else ${actorColumn(users, agents)} end`;
