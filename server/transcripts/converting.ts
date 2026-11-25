/** What the converters read their sources' records with. */

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A time as the source gave it, in ISO form; null for none or one that isn't a time. */
export function timeOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A tool result's content as text: a string as it is, or its text blocks joined, with other blocks named. */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      if (isObject(block) && block.type === "text" && typeof block.text === "string") return block.text;
      return isObject(block) && typeof block.type === "string" ? `[${block.type}]` : "";
    })
    .join("\n");
}
