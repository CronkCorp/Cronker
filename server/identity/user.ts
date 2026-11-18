import { Type, type Static } from "typebox";

export const User = Type.Object({ id: Type.String({ format: "uuid" }), email: Type.String() });
export type User = Static<typeof User>;

export const Email = Type.String({ format: "email", maxLength: 320 });
export const Password = Type.String({ minLength: 8, maxLength: 1024 });
