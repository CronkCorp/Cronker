import { Type, type TObject, type TProperties } from "typebox";
import type { Db } from "../db.js";
import type { Caller } from "../identity/callers.js";
import { AvoidedWord, avoidedWordsIn, type SavedTexts } from "../knowledge/avoided-words.js";
import type { Place } from "../knowledge/places.js";

/**
 * The response of a route saving text, warning Agents about the words the glossary avoids: each such route declares
 * its response with `withAvoidedWords` and answers with `warnAgent`, so none shapes the warning itself.
 */

const description =
  "For an Agent's save: each word the place's glossary avoids that the text uses, once, with the Term to use " +
  "instead; empty for a clean save. Words in code, block quotes and link targets don't count. The save went through " +
  "either way. Left out for a User's save.";

/** A response schema with the warning added. */
export function withAvoidedWords<P extends TProperties>(schema: TObject<P>) {
  return Type.Object({ ...schema.properties, avoidedWords: Type.Optional(Type.Array(AvoidedWord, { description })) });
}

/**
 * What a save answers: what it saved, with `avoidedWords` for an Agent's save, by the glossary of the place the texts
 * were saved in. Run it after the save is committed, so the check never holds a save back.
 */
export async function warnAgent<T extends object>(
  db: Db,
  caller: Caller,
  place: Place,
  texts: SavedTexts,
  saved: T,
): Promise<T & { avoidedWords?: AvoidedWord[] }> {
  if (caller.kind !== "agent") return saved;
  return { ...saved, avoidedWords: await avoidedWordsIn(db, place, texts) };
}
