import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import { attachmentUrl, type Mention } from "./api.js";
import { Link } from "./router.js";

/** A minimal view of the Markdown syntax tree, enough to find text outside links and code. */
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

/** Turns each mentioned Ticket key in the text into a link to its Ticket. */
function linkMentions(mentions: Mention[]) {
  const byText = new Map(mentions.map((m) => [m.text, m]));
  const escaped = mentions.map((m) => m.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`\\b(${escaped.join("|")})\\b`, "g");

  const split = (text: string): Node[] =>
    text
      .split(pattern)
      .filter((part) => part !== "")
      .map((part) => {
        const mention = byText.get(part);
        return mention
          ? { type: "link", url: `/tickets/${mention.ticketId}`, children: [{ type: "text", value: part }] }
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
    href?.startsWith("/api/") ? (
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
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[linkMentions(mentions)]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
