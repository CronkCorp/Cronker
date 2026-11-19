import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, violates, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { ownerName } from "../agents/tokens.js";
import type { Caller } from "../identity/callers.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { Actor, actorColumn } from "../work/actors.js";
import type { Tree } from "./documents.js";

/**
 * Terms: glossary entries naming one concept each, kept by a Project or by the Workspace. Each save makes a Version
 * recording its Actor; the Term shows its current Version.
 */

/** Which glossary a Term is in: a Project's own, or the Workspace's when `projectId` is null. */
export type Glossary = Tree;

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
});
export type Term = Static<typeof Term>;

type Row = Omit<Term, "version"> & { version: Omit<Term["version"], "savedAt"> & { savedAt: string } };

const columns = `terms.id, terms.workspace_id as "workspaceId", terms.project_id as "projectId", versions.name,
  versions.definition, versions.avoid,
  json_build_object('number', versions.number, 'actor', ${actorColumn("users", "agents")},
    'savedAt', versions.saved_at) as version`;

const fromTerms = `terms
  join term_versions versions on versions.term_id = terms.id and versions.number = terms.version
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const present = (row: Row): Term => ({
  ...row,
  version: { ...row.version, savedAt: new Date(row.version.savedAt).toISOString() },
});

/** A Term in the Viewer's view; otherwise nothing, as if it didn't exist. */
export async function findTerm(db: Db | Tx, viewer: Viewer, termId: string): Promise<Term | undefined> {
  if (!isUuid(termId)) return undefined;
  const view = inView(viewer, "terms.workspace_id", "$2");
  const { rows } = await db.query<Row>(`select ${columns} from ${fromTerms} where terms.id = $1 and ${view.sql}`, [
    termId,
    view.value,
  ]);
  return rows[0] && present(rows[0]);
}

export function termNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Term.");
}

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
    const place = glossary.projectId ? "this Project" : "the Workspace";
    throw new ApiError(409, "term_name_taken", `${place[0]!.toUpperCase()}${place.slice(1)} already has a Term named ${name}.`, {
      rule: "A Term's name is unique ignoring case among its Project's Terms, or among the Workspace's.",
      advice: `Edit the Term ${place} already has, or choose another name.`,
    });
  }
}

/** Creates a Term in the glossary at Version 1 by its Actor; refused if the glossary has its name, ignoring case. */
export async function createTerm({ db, clock }: Context, actor: Caller, glossary: Glossary, input: TermContent): Promise<Term> {
  return transaction(db, async (tx) => {
    const now = clock.now();
    const { rows } = await withUniqueName(glossary, input.name, () =>
      tx.query<{ id: string }>(
        `insert into terms (workspace_id, project_id, name, version, created_at) values ($1, $2, $3, 1, $4) returning id`,
        [glossary.workspaceId, glossary.projectId, input.name, now],
      ),
    );
    const id = rows[0]!.id;
    await insertVersion(tx, { id, workspaceId: glossary.workspaceId }, 1, input, actor, now);
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
  const view = inView(viewer, "terms.workspace_id", "$2");
  const { rows } = await tx.query<Glossary & { id: string; version: number }>(
    `select id, workspace_id as "workspaceId", project_id as "projectId", version from terms
     where terms.id = $1 and ${view.sql} for update`,
    [termId, view.value],
  );
  return rows[0];
}

export interface TermEdit extends Partial<TermContent> {
  /** The number of the Version the save is based on. */
  baseVersion: number;
}

/**
 * Saves a Term as its next Version by the Actor, keeping what the edit leaves out; a new name is refused if another
 * Term of its glossary has it, ignoring case. The save must be based on the
 * current Version: one based on an outdated Version is refused with the current one, so its Actor can see what
 * changed.
 */
export async function editTerm({ db, clock }: Context, actor: Caller, termId: string, edit: TermEdit): Promise<Term> {
  return transaction(db, async (tx) => {
    const locked = await lockTerm(tx, actor, termId);
    if (!locked) throw termNotFound();
    const current = (await versionOf(tx, locked.id, locked.version))!;
    if (edit.baseVersion !== current.number) {
      throw new ApiError(
        409,
        "outdated_version",
        `The Term is at Version ${current.number}, but this save is based on Version ${edit.baseVersion}.`,
        {
          rule: "A save based on an outdated Version is refused, so it never overwrites a change its Actor hasn't seen.",
          advice: "Merge your change into the current Version, given as `current`, and save again based on it.",
        },
        { current },
      );
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

/** The glossary's own Terms, by name ignoring case. */
export async function termsOf(db: Db, glossary: Glossary): Promise<Term[]> {
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
export async function glossaryOf(db: Db, project: { workspaceId: string; projectId: string }): Promise<Term[]> {
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

/** Deletes a Term with all its Versions; only a User may. */
export async function deleteTerm({ db }: Context, actor: Caller, termId: string): Promise<void> {
  await transaction(db, async (tx) => {
    const term = await lockTerm(tx, actor, termId);
    if (!term) throw termNotFound();
    if (actor.kind === "agent") {
      throw new ApiError(403, "agent_not_allowed", `${actor.name} is an Agent, and only a User can delete a Term.`, {
        rule: "Only a User deletes a Term, so an agent can't remove knowledge.",
        advice: `Leave the Term as it is, or edit it; ask ${ownerName(actor)}, ${actor.name}'s Owner, if it should go.`,
      });
    }
    await tx.query("delete from terms where id = $1", [term.id]);
  });
}
