import { useMemo } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { attachmentUrl, isAttachmentUrl, type ArtifactMention, type DecisionMention, type Mention, type TicketMention } from "./api.js";
import { Embed } from "./embed.js";
import { Link } from "./router.js";
import { useAddresses, type Addresses } from "./addresses.js";

/** A minimal view of the Markdown syntax tree, enough to find text outside links and code. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  data?: { hProperties?: Record<string, string> };
}

/** The address a paragraph holds alone, as written: bare, or as an autolink whose text is the address itself. */
function addressAlone(paragraph: Node): string | undefined {
  const [only, ...rest] = paragraph.children ?? [];
  if (!only || rest.length > 0) return undefined;
  if (only.type === "text") return only.value?.trim();
  const [text, ...more] = only.children ?? [];
  if (only.type === "link" && text?.type === "text" && more.length === 0 && text.value === only.url) return only.url;
  return undefined;
}

/**
 * Marks each paragraph that holds alone the address of an Artifact the text embeds, as the API says it does, to be
 * shown as an Embed: the API leaves out Artifacts the reader can't read, which then stay as written.
 */
function markEmbeds(embeds: ArtifactMention[]) {
  const byText = new Map(embeds.map((m, index) => [m.text, index]));
  const walk = (node: Node) => {
    if (node.type === "paragraph") {
      const address = addressAlone(node);
      const index = address === undefined ? undefined : byText.get(address);
      if (index !== undefined) node.data = { ...node.data, hProperties: { ...node.data?.hProperties, dataEmbed: String(index) } };
      return;
    }
    if (node.type === "link" || node.type === "linkReference") return;
    node.children?.forEach(walk);
  };
  return () => (tree: Node) => {
    if (embeds.length > 0) walk(tree);
  };
}

/** A Mention by a key, which links in place: a Ticket's or a Decision's. */
type KeyMention = TicketMention | DecisionMention;

/** The page a Mention leads to: its Ticket's or its Decision's. */
function mentionedPage(to: Addresses, mention: KeyMention): string {
  return mention.kind === "ticket"
    ? to.ticket(mention)
    : to.decision({ id: mention.decisionId, projectId: mention.projectId, number: mention.number });
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Turns each mentioned Ticket or Decision key in the text into a link to it, with the server's boundaries: a
 * Decision key never inside a longer word or key, so `D7` doesn't link inside `WEB-D7`, nor before `-3`, where
 * `D7-3` is a Ticket key.
 */
function linkMentions(mentions: KeyMention[], to: Addresses) {
  const byText = new Map(mentions.map((m) => [m.text, m]));
  const alternation = (kind: KeyMention["kind"]) =>
    mentions
      .filter((m) => m.kind === kind)
      .map((m) => m.text)
      .sort((a, b) => b.length - a.length)
      .map(escape)
      .join("|") || "(?!)";
  const pattern = new RegExp(
    `\\b(${alternation("ticket")})\\b|(?<![\\w-])(${alternation("decision")})(?!\\w|-[1-9])`,
    "g",
  );

  const split = (text: string): Node[] =>
    text
      .split(pattern)
      .filter((part): part is string => part !== undefined && part !== "")
      .map((part) => {
        const mention = byText.get(part);
        return mention
          ? { type: "link", url: mentionedPage(to, mention), children: [{ type: "text", value: part }] }
          : { type: "text", value: part };
      });

  const walk = (node: Node) => {
    if (!node.children || node.type === "link" || node.type === "linkReference") return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text" && child.value) return split(child.value);
      walk(child);
      return [child];
    });
  };

  return () => (tree: Node) => {
    if (mentions.length > 0) walk(tree);
  };
}

/** Resolves `attachment:<id>` to where the Attachment downloads from; other URLs as react-markdown allows them. */
function urlTransform(url: string): string {
  const attachment = /^attachment:([0-9a-f-]{36})$/i.exec(url.trim());
  return attachment ? attachmentUrl(attachment[1]!) : defaultUrlTransform(url);
}

const links: Components = {
  a: ({ href, children }) =>
    href && isAttachmentUrl(href) ? (
      <a href={href} download>
        {children}
      </a>
    ) : href?.startsWith("/") ? (
      <Link to={href}>{children}</Link>
    ) : (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ),
};

/**
 * Markdown as written by Users, without raw HTML, with Ticket and Decision keys as links, the Artifacts it embeds
 * shown in place and `attachment:` references resolved.
 */
export function Markdown({ text, mentions }: { text: string; mentions: Mention[] }) {
  const to = useAddresses();
  const keys = mentions.filter((m): m is KeyMention => m.kind !== "artifact");
  const embeds = mentions.filter((m): m is ArtifactMention => m.kind === "artifact");
  const components = useMemo<Components>(
    () => ({
      ...links,
      p: ({ node, children }) => {
        const index = node?.properties?.dataEmbed;
        const embed = typeof index === "string" ? embeds[Number(index)] : undefined;
        return embed ? <Embed mention={embed} /> : <p>{children}</p>;
      },
    }),
    // The Embeds as the API gives them; a new array of the same ones keeps each Embed, and its height, in place.
    [JSON.stringify(embeds)],
  );
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[markEmbeds(embeds), linkMentions(keys, to)]}
        components={components}
        urlTransform={urlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
