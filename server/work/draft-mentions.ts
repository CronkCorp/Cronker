import { Type, type Static } from "typebox";
import type { Db } from "../db.js";
import { inReach, type Viewer } from "../identity/viewers.js";
import {
  DecisionMention,
  glossaryNames,
  mentioned,
  TermMention,
  termsMentioned,
  TicketMention,
  type NamedTerm,
} from "./mentions.js";

/*
 * Mentions of a text still being written, which the rich editor links as it is edited, and what its Mention picker
 * offers: both read only, by the same rules and Access as the Mention index (`mentions.ts`), for a draft that isn't
 * saved, so not indexed.
 */

/** A Mention a draft holds: a Ticket's or a Decision's key, or a Term's name. */
export const KeyMention = Type.Union([TicketMention, DecisionMention, TermMention], {
  description: "A Ticket or Decision key or a Term name the draft holds; `kind` says which.",
});
export type KeyMention = Static<typeof KeyMention>;

/** Where a draft is written: a Project's text, by its id, or the Workspace's own (null). */
export interface DraftPlace {
  workspaceId: string;
  projectId: string | null;
}

/** The Terms of a place's glossary that the Viewer may read. */
async function readableGlossary(db: Db, viewer: Viewer, place: DraftPlace): Promise<NamedTerm[]> {
  const glossary = await glossaryNames(db, place.workspaceId, place.projectId);
  if (glossary.length === 0) return [];
  const reach = inReach(viewer, { project: "terms.project_id", workspace: "terms.workspace_id" }, "$2");
  const { rows } = await db.query<{ id: string }>(`select terms.id from terms where terms.id = any($1::uuid[]) and ${reach.sql}`, [
    glossary.map((term) => term.id),
    reach.value,
  ]);
  const readable = new Set(rows.map((row) => row.id));
  return glossary.filter((term) => readable.has(term.id));
}

/**
 * What a draft mentions, as it would once saved in its place: the keys naming a Ticket or Decision the Viewer may read
 * and the names of its glossary's Terms they may read, keys first, each once, in order of first mention. Anything
 * else stays plain text, as on the reading side.
 */
export async function draftMentions(db: Db, viewer: Viewer, place: DraftPlace, markdown: string): Promise<KeyMention[]> {
  const { keys } = mentioned(markdown);
  const found: { position: number; mention: KeyMention }[] = [];
  const tickets = keys.flatMap((key, position) => (key.kind === "ticket" ? [{ ...key, position }] : []));
  const decisions = keys.flatMap((key, position) => (key.kind === "decision" ? [{ ...key, position }] : []));
  if (tickets.length > 0) {
    const reach = inReach(viewer, { project: "tickets.project_id", workspace: "tickets.workspace_id" }, "$5");
    const { rows } = await db.query<TicketMention & { position: number }>(
      `select written.position, 'ticket' as kind, written.text, projects.key || '-' || tickets.number as key,
         tickets.id as "ticketId"
       from unnest($2::text[], $3::integer[], $4::text[], $6::integer[]) as written (project_key, number, text, position)
       join projects on projects.workspace_id = $1 and projects.key = written.project_key
       join tickets on tickets.project_id = projects.id and tickets.number = written.number
       where ${reach.sql}`,
      [
        place.workspaceId,
        tickets.map((key) => key.projectKey),
        tickets.map((key) => key.number),
        tickets.map((key) => key.written),
        reach.value,
        tickets.map((key) => key.position),
      ],
    );
    for (const { position, ...mention } of rows) found.push({ position, mention });
  }
  if (decisions.length > 0) {
    const reach = inReach(viewer, { project: "decisions.project_id", workspace: "decisions.workspace_id" }, "$5");
    const { rows } = await db.query<DecisionMention & { position: number }>(
      `select written.position, 'decision' as kind, written.text, concat(projects.key || '-', 'D', decisions.number) as key,
         decisions.id as "decisionId", decisions.project_id as "projectId", decisions.number
       from unnest($2::text[], $3::integer[], $4::text[], $6::integer[]) as written (project_key, number, text, position)
       left join projects on projects.workspace_id = $1 and projects.key = written.project_key
       join decisions on decisions.workspace_id = $1 and decisions.number = written.number
         and (decisions.project_id = projects.id or (written.project_key is null and decisions.project_id is null))
       where ${reach.sql}`,
      [
        place.workspaceId,
        decisions.map((key) => key.projectKey),
        decisions.map((key) => key.number),
        decisions.map((key) => key.written),
        reach.value,
        decisions.map((key) => key.position),
      ],
    );
    for (const { position, ...mention } of rows) found.push({ position, mention });
  }
  found.sort((a, b) => a.position - b.position);
  const glossary = await readableGlossary(db, viewer, place);
  const terms = termsMentioned(markdown, glossary);
  const projects = terms.length === 0 ? [] : (
    await db.query<{ id: string; projectId: string | null }>(
      `select id, project_id as "projectId" from terms where id = any($1::uuid[])`,
      [terms.map((term) => term.id)],
    )
  ).rows;
  const projectOf = new Map(projects.map((row) => [row.id, row.projectId]));
  return [
    ...found.map((entry) => entry.mention),
    ...terms.map((term): TermMention => ({ kind: "term", text: term.name, termId: term.id, name: term.name, projectId: projectOf.get(term.id) ?? null })),
  ];
}

/** Something the Mention picker offers: what picking it inserts, and what it shows. */
export const MentionCandidate = Type.Object({
  kind: Type.Union([Type.Literal("ticket"), Type.Literal("decision"), Type.Literal("term")]),
  id: Type.String({ format: "uuid", description: "The Ticket's, Decision's or Term's." }),
  text: Type.String({ description: "What picking it inserts: the Ticket's or Decision's key, or the Term's name." }),
  title: Type.String({ description: "A Ticket's or Decision's title; a Term's name." }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "Its Project, or null for the Workspace's own knowledge.",
  }),
});
export type MentionCandidate = Static<typeof MentionCandidate>;

/** At most this many of each kind are offered. */
export const candidatesPerKind = 10;

const likePrefix = (text: string) => `${text.replace(/[\\%_]/g, "\\$&")}%`;

/** The Tickets of a Project, by key, whose number starts with the digits given, the exact one first, then newest. */
async function ticketCandidates(db: Db, viewer: Viewer, workspaceId: string, projectKey: string, digits: string) {
  const reach = inReach(viewer, { project: "tickets.project_id", workspace: "tickets.workspace_id" }, "$4");
  const { rows } = await db.query<MentionCandidate>(
    `select 'ticket' as kind, tickets.id, projects.key || '-' || tickets.number as text, tickets.title,
       tickets.project_id as "projectId"
     from tickets join projects on projects.id = tickets.project_id
     where projects.workspace_id = $1 and projects.key = $2 and tickets.number::text like $3 and ${reach.sql}
     order by tickets.number::text = $5 desc, tickets.number desc
     limit ${candidatesPerKind}`,
    [workspaceId, projectKey, likePrefix(digits), reach.value, digits],
  );
  return rows;
}

/** A Project's Decisions, by its key, or the Workspace's own (null), whose number starts with the digits given. */
async function decisionCandidates(db: Db, viewer: Viewer, workspaceId: string, projectKey: string | null, digits: string) {
  const reach = inReach(viewer, { project: "decisions.project_id", workspace: "decisions.workspace_id" }, "$4");
  const { rows } = await db.query<MentionCandidate>(
    `select 'decision' as kind, decisions.id, concat(projects.key || '-', 'D', decisions.number) as text, versions.title,
       decisions.project_id as "projectId"
     from decisions
     join decision_versions versions on versions.decision_id = decisions.id and versions.number = decisions.version
     left join projects on projects.id = decisions.project_id
     where decisions.workspace_id = $1 and decisions.number::text like $3 and ${reach.sql}
       and (case when $2::text is null then decisions.project_id is null else projects.key = $2 end)
     order by decisions.number::text = $5 desc, decisions.number desc
     limit ${candidatesPerKind}`,
    [workspaceId, projectKey, likePrefix(digits), reach.value, digits],
  );
  return rows;
}

/**
 * What the Mention picker offers for the word typed before the cursor, among what the Viewer may read:
 *
 * - a Project's key and a hyphen, maybe with the start of a number (`WEB-`, `web-4`): that Project's Tickets by
 *   number, and with no number its Decisions too; `WEB-D` and `WEB-D3`: its Decisions;
 * - `D3`: the Workspace's own Decisions by number;
 * - a Project's key alone, in capitals (`WEB`): its Tickets and Decisions;
 * - and two or more characters starting a Term's name of the place's glossary, with its capitalisation.
 *
 * Anything else offers nothing.
 */
export async function mentionCandidates(db: Db, viewer: Viewer, place: DraftPlace, typed: string): Promise<MentionCandidate[]> {
  const offered: MentionCandidate[] = [];
  const keyed = /^([A-Za-z][A-Za-z0-9]{1,9})(?:-([Dd])?([0-9]{0,9}))?$/.exec(typed);
  const hyphen = typed.includes("-");
  if (keyed && (hyphen || typed === typed.toUpperCase())) {
    const [, key, decision, digits = ""] = keyed;
    const projectKey = key!.toUpperCase();
    if (!decision) offered.push(...(await ticketCandidates(db, viewer, place.workspaceId, projectKey, digits)));
    if (decision || digits === "") offered.push(...(await decisionCandidates(db, viewer, place.workspaceId, projectKey, digits)));
  }
  const own = /^[Dd]([1-9][0-9]{0,8})$/.exec(typed);
  if (own) offered.push(...(await decisionCandidates(db, viewer, place.workspaceId, null, own[1]!)));
  if ([...typed].length >= 2 && !hyphen) {
    const glossary = await readableGlossary(db, viewer, place);
    const named = glossary
      .filter((term) => term.name.startsWith(typed))
      .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name))
      .slice(0, candidatesPerKind);
    if (named.length > 0) {
      const { rows } = await db.query<{ id: string; projectId: string | null }>(
        `select id, project_id as "projectId" from terms where id = any($1::uuid[])`,
        [named.map((term) => term.id)],
      );
      const projectOf = new Map(rows.map((row) => [row.id, row.projectId]));
      offered.push(
        ...named.map((term): MentionCandidate => ({
          kind: "term",
          id: term.id,
          text: term.name,
          title: term.name,
          projectId: projectOf.get(term.id) ?? null,
        })),
      );
    }
  }
  return offered;
}
