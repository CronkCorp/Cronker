import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { afterCommit, transaction, violates, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Live } from "../live/live.js";
import { isUuid } from "../http/ids.js";
import { requireOwnerAct } from "../identity/acts.js";
import type { Caller } from "../identity/callers.js";
import { inReach, requireWrite, type Viewer } from "../identity/viewers.js";
import { Actor, actorColumn } from "../work/actors.js";
import { creatingRun, noticeKnowledge } from "../inbox/knowledge-notices.js";
import type { Place } from "./places.js";
import { ComparedLine, compareLines, compareWords } from "./compare.js";
import { outdatedVersion } from "./versions.js";
import { indexMentions, Mention, mentionedIn, MentioningText, mentionsOf, reindexMentions } from "../work/mentions.js";

/**
 * Terms: each names one concept, with its definition and the words to avoid, kept by a Project or by the Workspace. Each save makes a Version
 * recording its Actor; the Term shows its current Version.
 */

/** Which glossary a Term is in: a Project's own, or the Workspace's when `projectId` is null. */
export type Glossary = Place;

const content = {
  name: Type.String(),
  definition: Type.String({ description: "Markdown." }),
  avoid: Type.Array(Type.String(), { description: "Words to avoid in its place, in the order given." }),
};

export const Term = Type.Object({
  id: Type.String({ format: "uuid" }),
  workspaceId: Type.String({ format: "uuid" }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project whose Term it is, or null for the Workspace's.",
  }),
  ...content,
  version: Type.Object(
    {
      number: Type.Integer({ minimum: 1, description: "Counts up from 1 with each save of the Term." }),
      actor: Actor,
      savedAt: Type.String({ format: "date-time" }),
    },
    { description: "The current Version, which a save names as its base." },
  ),
  mentions: Type.Array(Mention, {
    description: "The Ticket and Decision keys and other Terms' names its definition mentions and the Artifacts it embeds that the caller may read.",
  }),
});
export type Term = Static<typeof Term>;

/** A Term as the API shows one alone: with the texts mentioning it. */
export const TermDetail = Type.Object({
  ...Term.properties,
  mentionedIn: Type.Array(MentioningText, {
    description:
      "Mentioned in: each other text whose Markdown mentions its name, with its capitalisation as a whole word, " +
      "outside code and links, by the glossary of the text's place, that the caller may read, most recently saved " +
      "first; for knowledge, only its current Version counts. Only a single Term's read lists it, not a glossary. " +
      "A Term's creation, rename or removal indexes the texts it may be mentioned in again shortly after its save.",
  }),
});
export type TermDetail = Static<typeof TermDetail>;

/** A Term as stored, without what its definition mentions. */
export type TermRecord = Omit<Term, "mentions">;

type Row = Omit<TermRecord, "version"> & { version: Omit<Term["version"], "savedAt"> & { savedAt: string } };

const columns = `terms.id, terms.workspace_id as "workspaceId", terms.project_id as "projectId", versions.name,
  versions.definition, versions.avoid,
  json_build_object('number', versions.number, 'actor', ${actorColumn("users", "agents")},
    'savedAt', versions.saved_at) as version`;

const fromTerms = `terms
  join term_versions versions on versions.term_id = terms.id and versions.number = terms.version
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const present = (row: Row): TermRecord => ({
  ...row,
  version: { ...row.version, savedAt: new Date(row.version.savedAt).toISOString() },
});

/** A Term in the Viewer's view, with the texts mentioning it; otherwise nothing, as if it didn't exist. */
export async function findTerm(db: Db | Tx, viewer: Viewer, termId: string): Promise<TermDetail | undefined> {
  if (!isUuid(termId)) return undefined;
  const view = inReach(viewer, { project: "terms.project_id", workspace: "terms.workspace_id" }, "$2");
  const { rows } = await db.query<Row>(`select ${columns} from ${fromTerms} where terms.id = $1 and ${view.sql}`, [
    termId,
    view.value,
  ]);
  if (!rows[0]) return undefined;
  const [term] = await withMentions(db, viewer, [present(rows[0])]);
  return {
    ...term!,
    mentionedIn: await mentionedIn(db, viewer, { kind: "term", id: term!.id, workspaceId: term!.workspaceId }),
  };
}

/** Terms with the Ticket and Decision keys their definitions mention that the Viewer may read. */
export async function withMentions(db: Db | Tx, viewer: Viewer, terms: TermRecord[]): Promise<Term[]> {
  const mentions = await mentionsOf(db, viewer, "term", terms.map((term) => term.id));
  return terms.map((term) => ({ ...term, mentions: mentions.get(term.id)! }));
}

export function termNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Term.");
}

const Name = Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" });
const Definition = Type.String({ maxLength: 20_000, description: "Markdown." });
const Avoid = Type.Array(Type.String({ minLength: 1, maxLength: 200, pattern: "\\S" }), {
  maxItems: 50,
  description: "Words to avoid in the Term's place, in the order given.",
});

/** The create-a-Term route's body. */
export const TermCreate = Type.Object({
  name: Name,
  definition: Type.Optional(Definition),
  avoid: Type.Optional(Avoid),
  runId: Type.Optional(
    Type.String({
      description:
        "For an Agent, its running Run the Term is created in: its New knowledge item waits for the Assignee of the Run's " +
        "Ticket rather than the Agent's Owner.",
    }),
  ),
});
export type TermCreate = Static<typeof TermCreate>;

/** The save-a-Term route's body. */
export const TermEdit = Type.Object({
  baseVersion: Type.Integer({ minimum: 1, description: "The Version the save is based on." }),
  name: Type.Optional(Name),
  definition: Type.Optional(Definition),
  avoid: Type.Optional(Avoid),
});
export type TermEdit = Static<typeof TermEdit>;

/** A Term's whole content, as a Version keeps it. */
export interface TermContent {
  name: string;
  definition: string;
  avoid: string[];
}

async function insertVersion(
  tx: Tx,
  term: { id: string; workspaceId: string },
  number: number,
  content: TermContent,
  actor: Caller,
  now: Date,
): Promise<void> {
  await tx.query(
    `insert into term_versions (term_id, number, workspace_id, name, definition, avoid, actor_user_id, actor_agent_id, saved_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      term.id,
      number,
      term.workspaceId,
      content.name,
      content.definition,
      content.avoid,
      actor.kind === "user" ? actor.id : null,
      actor.kind === "agent" ? actor.id : null,
      now,
    ],
  );
  // Each Version saved becomes the current one, whose Mentions count.
  await indexMentions(tx, "term", term, content.definition);
}

/**
 * Runs a write that sets a Term's name, refusing a name another Term of the same glossary has, ignoring case.
 * Rolls back the write's transaction when refused.
 */
async function withUniqueName<T>(glossary: Glossary, name: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!violates(error, "terms_project_name_key") && !violates(error, "terms_workspace_name_key")) throw error;
    const holder = glossary.projectId ? "this Project" : "the Workspace";
    throw new ApiError(409, "term_name_taken", `A Term named ${name} is already one of ${holder}'s, ignoring case.`, {
      rule: "A Term's name is unique ignoring case among its Project's Terms, or among the Workspace's.",
      advice: `Edit the Term ${holder} already has, or choose another name.`,
    });
  }
}

/** Tells the Workspace's streams that a Term was created, saved or deleted, so its glossary shows it. */
function termChanged(live: Live, tx: Tx, term: Glossary & { id: string }): void {
  live.publish(tx, term.workspaceId, { type: "term.changed", projectId: term.projectId, termId: term.id });
}

/**
 * Indexes again, once the transaction commits and without its response waiting, the texts a change to the glossary's
 * names changes: every text of the Workspace for a Workspace Term, the Project's texts for a Project Term.
 */
function reindexAfter({ db, jobs }: Context, tx: Tx, glossary: Glossary): void {
  const scope = { workspaceId: glossary.workspaceId, projectId: glossary.projectId };
  afterCommit(tx, () => jobs.add(`mentions ${scope.workspaceId} ${scope.projectId ?? "workspace"}`, () => reindexMentions(db, scope)));
}

/** Creates a Term in the glossary at Version 1 by its Actor; refused if the glossary has its name, ignoring case. */
export async function createTerm(
  context: Context,
  actor: Caller,
  glossary: Glossary,
  input: TermContent,
  runId?: string,
): Promise<TermDetail> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    await requireWrite(tx, actor, glossary);
    const run = await creatingRun(tx, actor, runId, "a Term");
    const now = clock.now();
    const { rows } = await withUniqueName(glossary, input.name, () =>
      tx.query<{ id: string }>(
        `insert into terms (workspace_id, project_id, name, version, created_at) values ($1, $2, $3, 1, $4) returning id`,
        [glossary.workspaceId, glossary.projectId, input.name, now],
      ),
    );
    const id = rows[0]!.id;
    await insertVersion(tx, { id, workspaceId: glossary.workspaceId }, 1, input, actor, now);
    await noticeKnowledge(tx, live, actor, { kind: "term", id, workspaceId: glossary.workspaceId }, run, now);
    termChanged(live, tx, { ...glossary, id });
    reindexAfter(context, tx, glossary);
    return (await findTerm(tx, actor, id))!;
  });
}

/** One saved state of a Term, recording which Actor saved it. */
export const TermVersion = Type.Object({
  number: Type.Integer({ minimum: 1, description: "Counts up from 1 with each save of the Term." }),
  ...content,
  actor: Actor,
  savedAt: Type.String({ format: "date-time" }),
});
export type TermVersion = Static<typeof TermVersion>;

type VersionRow = Omit<TermVersion, "savedAt"> & { savedAt: Date };

const versionColumns = `versions.number, versions.name, versions.definition, versions.avoid,
  ${actorColumn("users", "agents")} as actor, versions.saved_at as "savedAt"`;

const fromVersions = `term_versions versions
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const presentVersion = (row: VersionRow): TermVersion => ({ ...row, savedAt: row.savedAt.toISOString() });

async function versionOf(db: Db | Tx, termId: string, number: number): Promise<TermVersion | undefined> {
  const { rows } = await db.query<VersionRow>(
    `select ${versionColumns} from ${fromVersions} where versions.term_id = $1 and versions.number = $2`,
    [termId, number],
  );
  return rows[0] && presentVersion(rows[0]);
}

/** A Term's row, locked until the transaction ends, so writes to it queue up. */
async function lockTerm(tx: Tx, viewer: Viewer, termId: string): Promise<(Glossary & { id: string; version: number }) | undefined> {
  if (!isUuid(termId)) return undefined;
  const view = inReach(viewer, { project: "terms.project_id", workspace: "terms.workspace_id" }, "$2");
  const { rows } = await tx.query<Glossary & { id: string; version: number }>(
    `select id, workspace_id as "workspaceId", project_id as "projectId", version from terms
     where terms.id = $1 and ${view.sql} for update`,
    [termId, view.value],
  );
  return rows[0];
}


/**
 * Saves a Term as its next Version by the Actor, keeping what the edit leaves out; a new name is refused if another
 * Term of its glossary has it, ignoring case. The save must be based on the
 * current Version: one based on an outdated Version is refused with the current one, so its Actor can see what
 * changed.
 */
export async function editTerm(context: Context, actor: Caller, termId: string, edit: TermEdit): Promise<TermDetail> {
  const { db, clock, live } = context;
  return transaction(db, async (tx) => {
    const locked = await lockTerm(tx, actor, termId);
    if (!locked) throw termNotFound();
    await requireWrite(tx, actor, locked);
    const current = (await versionOf(tx, locked.id, locked.version))!;
    if (edit.baseVersion !== current.number) {
      throw outdatedVersion("Term", current, edit.baseVersion);
    }
    const number = current.number + 1;
    const content = {
      name: edit.name ?? current.name,
      definition: edit.definition ?? current.definition,
      avoid: edit.avoid ?? current.avoid,
    };
    await insertVersion(tx, locked, number, content, actor, clock.now());
    await withUniqueName(locked, content.name, () =>
      tx.query("update terms set version = $2, name = $3 where id = $1", [locked.id, number, content.name]),
    );
    termChanged(live, tx, locked);
    if (content.name !== current.name) reindexAfter(context, tx, locked);
    return (await findTerm(tx, actor, locked.id))!;
  });
}

/** A Term's Versions, oldest first. */
export async function versionsOf(db: Db, viewer: Viewer, termId: string): Promise<TermVersion[]> {
  const term = await findTerm(db, viewer, termId);
  if (!term) throw termNotFound();
  const { rows } = await db.query<VersionRow>(
    `select ${versionColumns} from ${fromVersions} where versions.term_id = $1 order by versions.number`,
    [term.id],
  );
  return rows.map(presentVersion);
}

/** One of a Term's Versions; a number it has no Version of is refused. */
export async function readTermVersion(db: Db, viewer: Viewer, termId: string, number: number): Promise<TermVersion> {
  const term = await findTerm(db, viewer, termId);
  if (!term) throw termNotFound();
  const version = await versionOf(db, term.id, number);
  if (!version) throw new ApiError(404, "not_found", `The Term ${term.name} has no Version ${number}.`);
  return version;
}

export const TermComparison = Type.Object({
  from: TermVersion,
  to: TermVersion,
  lines: Type.Array(ComparedLine, { description: "The definitions compared line by line, in order." }),
  avoid: Type.Array(ComparedLine, { description: "The words to avoid compared one word to a line, in order." }),
});
export type TermComparison = Static<typeof TermComparison>;

/** Two of a Term's Versions: their definitions compared line by line, and their words to avoid one by one. */
export async function compareTermVersions(
  db: Db,
  viewer: Viewer,
  termId: string,
  numbers: { from: number; to: number },
): Promise<TermComparison> {
  const from = await readTermVersion(db, viewer, termId, numbers.from);
  const to = await readTermVersion(db, viewer, termId, numbers.to);
  return {
    from,
    to,
    lines: compareLines(from.definition, to.definition),
    avoid: compareWords(from.avoid, to.avoid),
  };
}

/** The glossary's own Terms, by name ignoring case. */
export async function termsOf(db: Db, glossary: Glossary): Promise<TermRecord[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromTerms}
     where terms.workspace_id = $1 and terms.project_id is not distinct from $2
     order by lower(terms.name), terms.name`,
    [glossary.workspaceId, glossary.projectId],
  );
  return rows.map(present);
}

/**
 * A Project's glossary: its own Terms over the Workspace's, each Project Term replacing a Workspace Term of the same
 * name ignoring case; by name ignoring case.
 */
export async function glossaryOf(db: Db, project: Glossary & { projectId: string }): Promise<TermRecord[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from ${fromTerms}
     where terms.workspace_id = $1
       and (terms.project_id = $2
         or (terms.project_id is null and not exists (
           select 1 from terms own where own.project_id = $2 and lower(own.name) = lower(terms.name))))
     order by lower(terms.name), terms.name`,
    [project.workspaceId, project.projectId],
  );
  return rows.map(present);
}

/** Deletes a Term with all its Versions; only a User, or an Agent with a Full token, may. */
export async function deleteTerm(context: Context, actor: Caller, termId: string): Promise<void> {
  const { db, live } = context;
  await transaction(db, async (tx) => {
    const term = await lockTerm(tx, actor, termId);
    if (!term) throw termNotFound();
    await requireWrite(tx, actor, term);
    requireOwnerAct(actor, {
      act: "deleting a Term",
      rule: "An Agent with a Write token doesn't delete a Term, so delegated work can't remove knowledge; leave it, or edit it.",
    });
    await tx.query("delete from mentions where source_term_id = $1 or target_term_id = $1", [term.id]);
    await tx.query("delete from terms where id = $1", [term.id]);
    termChanged(live, tx, term);
    // Its Mentions go with it; a Workspace Term of the same name a Project Term replaced comes back in the Project.
    reindexAfter(context, tx, term);
  });
}
