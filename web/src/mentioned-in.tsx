import type { MentioningText } from "./api.js";
import { useAddresses, type Addresses } from "./addresses.js";
import { Link } from "./router.js";
import { KindLabel } from "./ui/labels.js";

const mentioningKinds: Record<MentioningText["kind"], string> = {
  ticket: "Ticket",
  comment: "Comment",
  document: "Document",
  report: "Report",
  term: "Term",
  decision: "Decision",
};

/** The page a text mentioning a Ticket or a Term is read on: a Comment's is its Ticket's. */
function mentioningPage(to: Addresses, text: MentioningText): string {
  switch (text.kind) {
    case "ticket":
    case "comment":
      return to.ticket(text.ticket!);
    case "document":
    case "report":
      return to.document({ slug: text.slug! });
    case "term":
      return to.term({ id: text.id, projectId: text.projectId, name: text.title });
    case "decision":
      return to.decision({ id: text.id, projectId: text.projectId, number: text.number! });
  }
}

/** Mentioned in: each text whose Markdown mentions a Ticket's key or a Term's name, linked, with what kind of text it is. */
export function MentionedIn({ texts }: { texts: MentioningText[] }) {
  const to = useAddresses();
  if (texts.length === 0) return null;
  return (
    <section aria-label="Mentioned in" className="panel side-section">
      <h2 className="side-title">Mentioned in</h2>
      <ul aria-label="Mentioned in" className="side-list">
        {texts.map((text) => (
          <li key={`${text.kind}:${text.id}`}>
            <KindLabel kind={mentioningKinds[text.kind]} />{" "}
            {text.ticket && text.kind !== "report" && <span className="muted small">{text.ticket.key} </span>}
            <Link to={mentioningPage(to, text)}>{text.title}</Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
