import { Type, type TSchema } from "typebox";

/**
 * The fields the Ticket routes' bodies share. Each body is a named schema beside the domain function it feeds; the
 * route uses it as its `body`, the web client takes its request type from it and the MCP tools build their inputs
 * from it, so a limit written here holds for all three.
 */

/** A title: a short line, not only spaces. */
export const title = (description?: string) =>
  Type.String({ minLength: 1, maxLength: 300, pattern: "\\S", ...(description ? { description } : {}) });

/** A Ticket's description, in Markdown. */
export const Description = Type.String({ maxLength: 100_000, description: "Markdown." });

/** A Markdown text that isn't empty, such as a Comment's or a Report's body. */
export const markdown = (maxLength: number, description = "Markdown.") =>
  Type.String({ minLength: 1, maxLength, pattern: "\\S", description });

export const Label = Type.String({ minLength: 1, maxLength: 50, pattern: "\\S" });

/**
 * The schema, or `null` to clear it. Null comes first: the body's type coercion would otherwise turn null into 0
 * or "".
 */
export const nullable = <T extends TSchema>(schema: T, description?: string) =>
  Type.Union([Type.Null(), schema], description ? { description } : {});
