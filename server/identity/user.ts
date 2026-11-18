import { Type, type Static } from "typebox";

export const User = Type.Object({ id: Type.String({ format: "uuid" }), email: Type.String() });
export type User = Static<typeof User>;
