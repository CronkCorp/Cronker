import { Type } from "typebox";

/** What a Status means, whatever its name. Every Project keeps at least one Status of each kind. */
export const statusKinds = ["backlog", "active", "review", "done", "canceled"] as const;
export type StatusKind = (typeof statusKinds)[number];
// Spelled out, not mapped from `statusKinds`, so its static type is the kinds rather than never.
export const StatusKind = Type.Union([
  Type.Literal("backlog"),
  Type.Literal("active"),
  Type.Literal("review"),
  Type.Literal("done"),
  Type.Literal("canceled"),
]);
