import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { attachmentUrl, isAttachmentUrl, type Mention } from "./api.js";
import { Link } from "./router.js";
import { useAddresses, type Addresses } from "./addresses.js";

/** A minimal view of the Markdown syntax tree, enough to find text outside links and code. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

/** The page a Mention leads to: its Ticket's or its Decision's. */
function mentionedPage(to: Addresses, mention: Mention): string {
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
function linkMentions(mentions: Mention[], to: Addresses) {
  const byText = new Map(mentions.map((m) => [m.text, m]));
  const alternation = (kind: Mention["kind"]) =>
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

const components: Components = {
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

/** Markdown as written by Users, without raw HTML, with Ticket keys as links and `attachment:` references resolved. */
export function Markdown({ text, mentions }: { text: string; mentions: Mention[] }) {
  const to = useAddresses();
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[linkMentions(mentions, to)]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
