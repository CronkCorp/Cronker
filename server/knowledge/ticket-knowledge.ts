import { Type, type Static } from "typebox";
import type { Db, Tx } from "../db.js";
import { inReach, type Viewer } from "../identity/viewers.js";
import { literals } from "../literals.js";
import { DecisionStatus } from "./decisions.js";

/*
 * A Ticket's knowledge: the Terms and Decisions its description and Comments mention, read from the Mention index
 * (`work/mentions.ts`), which stays the only matcher, so a Run reads the meaning of the words its Ticket uses and
 * which choices still stand.
 */

const Scope = literals(["project", "workspace"] as const, {
  description: "Whose it is: its Project's, or the Workspace's own.",
});

/** A Term a Ticket mentions, with its meaning. */
export const KnownTerm = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  definition: Type.String({ description: "Markdown." }),
  avoid: Type.Array(Type.String(), { description: "Words to avoid in its place, in the order given." }),
  scope: Scope,
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project whose Term it is, or null for the Workspace's.",
  }),
});
export type KnownTerm = Static<typeof KnownTerm>;

/** A Decision a Ticket mentions, without its body: read it with its key for the reasoning. */
export const KnownDecision = Type.Object({
  id: Type.String({ format: "uuid" }),
  key: Type.String({ description: "The Decision's key: `WEB-D7` for a Project's, `D7` for the Workspace's own." }),
  title: Type.String(),
  status: DecisionStatus,
  scope: Scope,
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Decision's Project, or null for the Workspace's own.",
  }),
});
export type KnownDecision = Static<typeof KnownDecision>;

export const TicketKnowledge = Type.Object(
  {
    terms: Type.Array(KnownTerm),
    decisions: Type.Array(KnownDecision),
  },
  {
    description:
      "The Terms and Decisions its description and its own Comments mention that the caller may read, each once, in " +
      "order of first mention (the description first, then the Comments oldest first), a Project's Term over the " +
      "Workspace's of the same name. It follows the Mention index, which a Term's creation, rename or removal updates " +
      "shortly after its save.",
  },
);
export type TicketKnowledge = Static<typeof TicketKnowledge>;

/** The Mentions of the Ticket's description and of its Comments, with where each comes in order. */
const hits = `hits as (
  select mentions.*, 0::bigint as seq from mentions where mentions.source_ticket_id = $1
  union all
  select mentions.*, comments.seq from mentions join comments on comments.id = mentions.source_comment_id
  where comments.ticket_id = $1
)`;

/** The Terms and Decisions a Ticket's description and Comments mention, as far as the Viewer may read them. */
export async function knowledgeOf(db: Db | Tx, viewer: Viewer, ticketId: string): Promise<TicketKnowledge> {
  const decisionReach = inReach(viewer, { project: "decisions.project_id", workspace: "decisions.workspace_id" }, "$2");
  const decisions = await db.query<KnownDecision & { seq: string; position: number }>(
    `with ${hits}
     select hits.seq, hits.position, decisions.id, concat(projects.key || '-', 'D', decisions.number) as key,
       versions.title, versions.status, decisions.project_id as "projectId"
     from hits
     left join projects on projects.workspace_id = hits.workspace_id and projects.key = hits.project_key
     join decisions on decisions.workspace_id = hits.workspace_id and decisions.number = hits.number
       and (decisions.project_id = projects.id or (hits.project_key is null and decisions.project_id is null))
     join decision_versions versions on versions.decision_id = decisions.id and versions.number = decisions.version
     where hits.target_kind = 'decision' and ${decisionReach.sql}`,
    [ticketId, decisionReach.value],
  );
  // Terms are read only for Tickets mentioning some, as a database migrated short of Terms has no `terms`.
  const { rowCount: naming } = await db.query(`with ${hits} select 1 from hits where target_kind = 'term' limit 1`, [
    ticketId,
  ]);
  const termReach = inReach(viewer, { project: "terms.project_id", workspace: "terms.workspace_id" }, "$2");
  const terms = !naming
    ? undefined
    : await db.query<Omit<KnownTerm, "scope"> & { seq: string; position: number }>(
        `with ${hits}
         select hits.seq, hits.position, terms.id, versions.name, versions.definition, versions.avoid,
           terms.project_id as "projectId"
         from hits
         join terms on terms.id = hits.target_term_id
         join term_versions versions on versions.term_id = terms.id and versions.number = terms.version
         where hits.target_kind = 'term' and ${termReach.sql}`,
        [ticketId, termReach.value],
      );
  const known = {
    terms: firstOfEach(terms?.rows ?? []).map((term) => ({ ...term, scope: scopeOf(term.projectId) })),
    decisions: firstOfEach(decisions.rows).map((decision) => ({ ...decision, scope: scopeOf(decision.projectId) })),
  };
  // Each text records its winning Term when indexed; until a re-index catches up, a Project's Term still wins.
  const projectNames = new Set(known.terms.filter((term) => term.projectId).map((term) => term.name.toLowerCase()));
  known.terms = known.terms.filter((term) => term.projectId || !projectNames.has(term.name.toLowerCase()));
  return known;
}

const scopeOf = (projectId: string | null) => (projectId ? "project" : "workspace") as "project" | "workspace";

/** Each record once, at its first mention, in order of first mention, without where it comes. */
function firstOfEach<T extends { id: string; seq: string; position: number }>(rows: T[]): Omit<T, "seq" | "position">[] {
  const sorted = [...rows].sort((a, b) => Number(a.seq) - Number(b.seq) || a.position - b.position);
  const seen = new Set<string>();
  const first = [];
  for (const { seq: _, position: __, ...row } of sorted) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    first.push(row);
  }
  return first;
}
