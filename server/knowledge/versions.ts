import { Type, type TObject, type TProperties } from "typebox";
import { ApiError, ErrorBody } from "../http/errors.js";

/**
 * Versions of knowledge: a save names the Version it's based on, and one based on an outdated Version is refused
 * with the current one, so its Actor can see what changed.
 */

/** What is kept with Versions. */
export type VersionedKind = "Document" | "Term" | "Decision" | "Artifact";

/** Refuses a save of the Document, Term, Decision or Artifact based on `base`, carrying its `current` Version. */
export function outdatedVersion(kind: VersionedKind, current: { number: number }, base: number): ApiError {
  return new ApiError(
    409,
    "outdated_version",
    `The ${kind} is at Version ${current.number}, but this save is based on Version ${base}.`,
    {
      rule: "A save based on an outdated Version is refused, so it never overwrites a change its Actor hasn't seen.",
      advice: "Merge your change into the current Version, given as `current`, and save again based on it.",
    },
    { current },
  );
}

/** The body of a save refused for being based on an outdated Version, with the current Version to merge into. */
export function OutdatedVersionBody(kind: VersionedKind, version: TObject<TProperties>) {
  return Type.Object({
    error: Type.Object({
      ...ErrorBody.properties.error.properties,
      current: Type.Optional(Type.Object(version.properties, { description: `The ${kind}'s current Version.` })),
    }),
  });
}
