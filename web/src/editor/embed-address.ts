// An Embed's address as the editor reads it: the same rules as the Mention
// index's (`embedAddress` and `addressAlone` in server/work/mentions.ts), so
// the editor shows an Embed for exactly the paragraphs the server records as
// one. The web client can't import server modules at runtime, so the rules are
// kept here as well; test/editor/embeds.test.ts checks both agree.
import type { Paragraph } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

/** An Artifact's address as an Embed writes it, taken apart. */
export interface EmbedAddress {
  /** The Workspace's slug the path starts with; null for the older `/artifacts/<id>`. */
  workspace: string | null;
  /** The Artifact's slug, or its id. */
  slug: string;
  version: number | null;
}

/**
 * An Artifact's address: `/<workspace>/artifacts/<slug>`, or the older `/artifacts/<id>`, either after Cronk's origin
 * or alone, with `?version=N` naming a Version. Nothing else, so not with any other query or a fragment.
 */
export function embedAddress(written: string): EmbedAddress | undefined {
  if (!/^(https?:\/\/[^/\s]+)?\/\S*$/i.test(written)) return undefined;
  let url: URL;
  try {
    url = new URL(written, "http://cronk.invalid");
  } catch {
    return undefined;
  }
  if (url.hash || url.username || url.password) return undefined;
  const query = [...url.searchParams];
  let version: number | null = null;
  if (query.length > 0) {
    const [[name, value]] = query as [[string, string]];
    if (query.length > 1 || name !== "version" || !/^[1-9][0-9]{0,8}$/.test(value)) return undefined;
    version = Number(value);
  }
  let parts: string[];
  try {
    parts = url.pathname.split("/").slice(1).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (parts.length === 3 && parts[1] === "artifacts" && parts[0] && parts[2]) {
    return { workspace: parts[0].toLowerCase(), slug: parts[2], version };
  }
  if (parts.length === 2 && parts[0] === "artifacts" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1]!)) {
    return { workspace: null, slug: parts[1]!.toLowerCase(), version };
  }
  return undefined;
}

/**
 * The address a paragraph holds alone, as written: a bare address, or one as an autolink (`<…>`) whose text is the
 * address itself. A link with words of its own, or anything else beside the address, makes no Embed.
 */
export function addressAlone(paragraph: Paragraph): string | undefined {
  if (paragraph.children.length !== 1) return undefined;
  const [only] = paragraph.children as [Paragraph["children"][number]];
  let written: string | undefined;
  if (only.type === "text") written = only.value.trim();
  else if (only.type === "link" && only.children.length === 1 && only.children[0]!.type === "text" && only.children[0]!.value === only.url) {
    written = only.url;
  }
  return written !== undefined && embedAddress(written) ? written : undefined;
}

/**
 * The address a block of Markdown holds alone in its one paragraph, read as the Mention index reads it (CommonMark,
 * without GitHub's bare links), or undefined when the block is no Embed.
 */
export function embedIn(source: string): string | undefined {
  const { children } = fromMarkdown(source);
  const [only] = children;
  return children.length === 1 && only!.type === "paragraph" ? addressAlone(only) : undefined;
}
