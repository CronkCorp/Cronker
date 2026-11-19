import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { ownerName } from "../agents/tokens.js";
import type { Caller } from "../identity/callers.js";
import { inView, type Viewer } from "../identity/viewers.js";
import { Actor, actorColumn } from "../work/actors.js";
import { ComparedLine, compareLines } from "./compare.js";

/**
 * Documents: written knowledge kept as Markdown in the page tree of a Project or of the Workspace. Each save
 * makes a Version recording its Actor; the Document shows its current Version.
 */

/** One saved state of a Document, without its body. */
export const Version = Type.Object({
  number: Type.Integer({ minimum: 1, description: "Counts up from 1 with each save of the Document." }),
  title: Type.String(),
  actor: Actor,
  savedAt: Type.String({ format: "date-time" }),
});
export type Version = Static<typeof Version>;

export const Document = Type.Object({
  id: Type.String({ format: "uuid" }),
  workspaceId: Type.String({ format: "uuid" }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Project whose page tree holds it, or null for the Workspace's.",
  }),
  parentId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Document above it in the same page tree, or null at the top.",
  }),
  position: Type.Integer({ minimum: 0, description: "Its place among its siblings, counting from 0." }),
  title: Type.String(),
  body: Type.String({ description: "Markdown." }),
  version: Type.Object(Version.properties, { description: "The current Version, which a save names as its base." }),
});
export type Document = Static<typeof Document>;

/** Which page tree a Document is in: a Project's, or the Workspace's when `projectId` is null. */
export interface Tree {
  workspaceId: string;
  projectId: string | null;
}

type Row = Omit<Document, "version"> & { version: Omit<Version, "savedAt"> & { savedAt: string } };

const columns = `documents.id, documents.workspace_id as "workspaceId", documents.project_id as "projectId",
  documents.parent_id as "parentId", documents.position, versions.title, versions.body,
  json_build_object('number', versions.number, 'title', versions.title,
    'actor', ${actorColumn("users", "agents")}, 'savedAt', versions.saved_at) as version`;

const fromDocuments = `documents
  join document_versions versions on versions.document_id = documents.id and versions.number = documents.version
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const present = (row: Row): Document => ({
  ...row,
  version: { ...row.version, savedAt: new Date(row.version.savedAt).toISOString() },
});

/** A Document in the Viewer's view; otherwise nothing, as if it didn't exist. */
export async function findDocument(db: Db | Tx, viewer: Viewer, documentId: string): Promise<Document | undefined> {
  if (!isUuid(documentId)) return undefined;
  const view = inView(viewer, "documents.workspace_id", "$2");
  const { rows } = await db.query<Row>(`select ${columns} from ${fromDocuments} where documents.id = $1 and ${view.sql}`, [
    documentId,
    view.value,
  ]);
  return rows[0] && present(rows[0]);
}

export function documentNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Document.");
}

/** Holds the page tree's writes in this transaction, so positions among siblings stay whole. */
async function lockTree(tx: Tx, tree: Tree): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtext('documents ' || $1 || ' ' || $2))", [
    tree.workspaceId,
    tree.projectId ?? "workspace",
  ]);
}

/** Records a Version of the Document, numbered, by its Actor. */
export async function insertVersion(
  tx: Tx,
  document: { id: string; workspaceId: string },
  number: number,
  content: { title: string; body: string },
  actor: { kind: "user" | "agent"; id: string },
  now: Date,
): Promise<void> {
  await tx.query(
    `insert into document_versions (document_id, number, workspace_id, title, body, actor_user_id, actor_agent_id, saved_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      document.id,
      number,
      document.workspaceId,
      content.title.trim(),
      content.body,
      actor.kind === "user" ? actor.id : null,
      actor.kind === "agent" ? actor.id : null,
      now,
    ],
  );
}

export const DocumentSummary = Type.Omit(Document, ["body"]);
export type DocumentSummary = Static<typeof DocumentSummary>;

/** A page tree's Documents in tree order: each right after its parent, siblings by their place; without bodies. */
export async function treeOf(db: Db, tree: Tree): Promise<DocumentSummary[]> {
  const { rows } = await db.query<Row>(
    `with recursive ordered (id, path) as (
       select id, array[position] from documents
       where workspace_id = $1 and project_id is not distinct from $2 and parent_id is null and ticket_id is null
       union all
       select documents.id, ordered.path || documents.position
       from documents join ordered on documents.parent_id = ordered.id
     )
     select ${columns} from ordered join ${fromDocuments} on documents.id = ordered.id
     order by ordered.path`,
    [tree.workspaceId, tree.projectId],
  );
  return rows.map((row) => {
    const { body: _body, ...summary } = present(row);
    return summary;
  });
}

/** How many Documents but `except` sit directly under the parent, or at the top of the tree for none. */
async function siblingCount(tx: Tx, tree: Tree, parentId: string | null, except: string | null = null): Promise<number> {
  const { rows } = await tx.query<{ count: number }>(
    `select count(*)::int as count from documents
     where workspace_id = $1 and project_id is not distinct from $2 and parent_id is not distinct from $3
       and ticket_id is null and id is distinct from $4`,
    [tree.workspaceId, tree.projectId, parentId, except],
  );
  return rows[0]!.count;
}

/** How many Documents sit directly under the Document. */
const childCount = (tx: Tx, document: Tree & { id: string }) => siblingCount(tx, document, document.id);

/** Refuses a parent that isn't a Document of the same page tree. */
async function requireParentInTree(tx: Tx, tree: Tree, parentId: string): Promise<void> {
  const { rowCount } = isUuid(parentId)
    ? await tx.query(
        `select 1 from documents
         where id = $1 and workspace_id = $2 and project_id is not distinct from $3 and ticket_id is null`,
        [parentId, tree.workspaceId, tree.projectId],
      )
    : { rowCount: 0 };
  if (rowCount === 0) {
    throw new ApiError(409, "parent_outside_tree", "The parent must be a Document of the same page tree.", {
      rule: "A Document's parent is in its own page tree: a Project's and the Workspace's are separate.",
      advice: "List the page tree's Documents and choose a parent among them, or leave the parent out.",
    });
  }
}

/**
 * Makes room at a place among the parent's children, or closes the gap a Document left there, moving each
 * Document but `except` from that place on.
 */
async function shiftSiblings(
  tx: Tx,
  tree: Tree,
  parentId: string | null,
  from: number,
  by: 1 | -1,
  except: string | null = null,
): Promise<void> {
  await tx.query(
    `update documents set position = position + $5
     where workspace_id = $1 and project_id is not distinct from $2 and parent_id is not distinct from $3
       and ticket_id is null and position >= $4 and id is distinct from $6`,
    [tree.workspaceId, tree.projectId, parentId, from, by, except],
  );
}

/**
 * Creates a Document in the page tree, under a parent of the same tree or at the top, at a place among its
 * siblings or last, at Version 1 by its Actor.
 */
export async function createDocument(
  { db, clock }: Context,
  actor: Caller,
  tree: Tree,
  input: { title: string; body: string; parentId?: string | null; position?: number },
): Promise<Document> {
  return transaction(db, async (tx) => {
    await lockTree(tx, tree);
    const parentId = input.parentId ?? null;
    if (parentId) await requireParentInTree(tx, tree, parentId);
    const count = await siblingCount(tx, tree, parentId);
    const position = Math.min(input.position ?? count, count);
    await shiftSiblings(tx, tree, parentId, position, 1);
    const now = clock.now();
    const { rows } = await tx.query<{ id: string }>(
      `insert into documents (workspace_id, project_id, parent_id, position, version, created_at)
       values ($1, $2, $3, $4, 1, $5) returning id`,
      [tree.workspaceId, tree.projectId, parentId, position, now],
    );
    const id = rows[0]!.id;
    await insertVersion(tx, { id, workspaceId: tree.workspaceId }, 1, input, actor, now);
    return (await findDocument(tx, actor, id))!;
  });
}

/**
 * Moves a Document under another parent of its page tree, or to the top, at a place among its new siblings or
 * last; or to another place among its siblings. Refused under itself or one of its own descendants. Takes the
 * Document locked with its page tree.
 */
async function moveDocument(tx: Tx, document: Placed, to: { parentId?: string | null; position?: number }): Promise<void> {
  const parentId = to.parentId === undefined ? document.parentId : to.parentId;
  if (parentId) {
    await requireParentInTree(tx, document, parentId);
    const { rowCount } = await tx.query(
      `with recursive above (id, parent_id) as (
         select id, parent_id from documents where id = $1
         union all
         select documents.id, documents.parent_id from documents join above on documents.id = above.parent_id
       )
       select 1 from above where id = $2`,
      [parentId, document.id],
    );
    if (rowCount) {
      throw new ApiError(409, "document_cycle", "A Document can't move under itself or one of its own descendants.", {
        rule: "A page tree has no cycles: a Document never sits under itself.",
        advice: "Choose a parent outside the Document's own branch, or move its children out first.",
      });
    }
  }
  if (parentId === document.parentId && to.position === undefined) return;
  // Leaving its place closes the gap there, then its new siblings make room.
  await shiftSiblings(tx, document, document.parentId, document.position + 1, -1, document.id);
  const count = await siblingCount(tx, document, parentId, document.id);
  const position = Math.min(to.position ?? count, count);
  await shiftSiblings(tx, document, parentId, position, 1, document.id);
  await tx.query("update documents set parent_id = $2, position = $3 where id = $1", [document.id, parentId, position]);
}

/** One saved state of a Document with its body. */
export const VersionWithBody = Type.Object({ ...Version.properties, body: Type.String({ description: "Markdown." }) });
export type VersionWithBody = Static<typeof VersionWithBody>;

type VersionRow = Omit<VersionWithBody, "savedAt"> & { savedAt: Date };

const versionColumns = `versions.number, versions.title, versions.body, ${actorColumn("users", "agents")} as actor,
  versions.saved_at as "savedAt"`;

const fromVersions = `document_versions versions
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const presentVersion = (row: VersionRow): VersionWithBody => ({ ...row, savedAt: row.savedAt.toISOString() });

async function versionOf(db: Db | Tx, documentId: string, number: number): Promise<VersionWithBody | undefined> {
  const { rows } = await db.query<VersionRow>(
    `select ${versionColumns} from ${fromVersions} where versions.document_id = $1 and versions.number = $2`,
    [documentId, number],
  );
  return rows[0] && presentVersion(rows[0]);
}

/** A Document as a write needs it: where it sits, and the number of its current Version. */
type Placed = Tree & { id: string; version: number; parentId: string | null; position: number };

/**
 * The Document's row, locked until the transaction ends, so writes to it queue up. With `tree`, its page tree's
 * lock is taken first: every write holding both takes the tree's before the row's, so none waits on the other.
 */
async function lockDocument(tx: Tx, viewer: Viewer, documentId: string, { tree = false } = {}): Promise<Placed | undefined> {
  if (!isUuid(documentId)) return undefined;
  const view = inView(viewer, "documents.workspace_id", "$2");
  const select = `select id, workspace_id as "workspaceId", project_id as "projectId", parent_id as "parentId", position,
    version from documents where id = $1 and ${view.sql}`;
  if (tree) {
    // A Document never changes page tree, so the one read before locking is the one it is in.
    const found = (await tx.query<Placed>(select, [documentId, view.value])).rows[0];
    if (!found) return undefined;
    await lockTree(tx, found);
  }
  return (await tx.query<Placed>(`${select} for update`, [documentId, view.value])).rows[0];
}

export interface DocumentEdit {
  /** The number of the Version the save is based on; needed for a new title or body. */
  baseVersion?: number;
  title?: string;
  body?: string;
  /** Another parent in the same page tree, or null for the top. */
  parentId?: string | null;
  /** A place among its siblings, counting from 0; last if past the end, or when moving to another parent without one. */
  position?: number;
}

/**
 * Saves or moves a Document. A new title or body makes the next Version by the Actor, and must be based on the
 * current Version: a save based on an outdated one is refused with the current Version, so its Actor can see what
 * changed. Moving it makes no Version.
 */
export async function editDocument(
  { db, clock }: Context,
  actor: Caller,
  documentId: string,
  edit: DocumentEdit,
): Promise<Document> {
  return transaction(db, async (tx) => {
    const moving = edit.parentId !== undefined || edit.position !== undefined;
    const document = await lockDocument(tx, actor, documentId, { tree: moving });
    if (!document) throw documentNotFound();
    if (edit.title !== undefined || edit.body !== undefined) {
      if (edit.baseVersion === undefined) {
        throw new ApiError(400, "base_version_needed", "A save names the Version it's based on, as `baseVersion`.", {
          rule: "A save names the Version it's based on, so it never overwrites a change its Actor hasn't seen.",
          advice: `Read the Document and save again with \`baseVersion\` set to its current Version's number.`,
        });
      }
      const current = (await versionOf(tx, document.id, document.version))!;
      if (edit.baseVersion !== current.number) {
        throw new ApiError(
          409,
          "outdated_version",
          `The Document is at Version ${current.number}, but this save is based on Version ${edit.baseVersion}.`,
          {
            rule: "A save based on an outdated Version is refused, so it never overwrites a change its Actor hasn't seen.",
            advice: "Merge your change into the current Version, given as `current`, and save again based on it.",
          },
          { current },
        );
      }
      const number = current.number + 1;
      const content = { title: edit.title ?? current.title, body: edit.body ?? current.body };
      await insertVersion(tx, document, number, content, actor, clock.now());
      await tx.query("update documents set version = $2 where id = $1", [document.id, number]);
    }
    if (moving) await moveDocument(tx, document, edit);
    return (await findDocument(tx, actor, document.id))!;
  });
}

/** A Document's Versions, oldest first, without their bodies. */
export async function versionsOf(db: Db, viewer: Viewer, documentId: string): Promise<Version[]> {
  const document = await findDocument(db, viewer, documentId);
  if (!document) throw documentNotFound();
  const { rows } = await db.query<VersionRow>(
    `select ${versionColumns} from ${fromVersions} where versions.document_id = $1 order by versions.number`,
    [document.id],
  );
  return rows.map(({ body: _body, ...row }) => ({ ...row, savedAt: row.savedAt.toISOString() }));
}

/** One of a Document's Versions, with its body. */
export async function readVersion(db: Db, viewer: Viewer, documentId: string, number: number): Promise<VersionWithBody> {
  const document = await findDocument(db, viewer, documentId);
  if (!document) throw documentNotFound();
  const version = await versionOf(db, document.id, number);
  if (!version) throw new ApiError(404, "not_found", `${document.title} has no Version ${number}.`);
  return version;
}

export const Comparison = Type.Object({
  from: VersionWithBody,
  to: VersionWithBody,
  lines: Type.Array(ComparedLine, { description: "The bodies compared line by line, in order." }),
});
export type Comparison = Static<typeof Comparison>;

/** Two of a Document's Versions, their bodies compared line by line. */
export async function compareVersions(
  db: Db,
  viewer: Viewer,
  documentId: string,
  numbers: { from: number; to: number },
): Promise<Comparison> {
  const from = await readVersion(db, viewer, documentId, numbers.from);
  const to = await readVersion(db, viewer, documentId, numbers.to);
  return { from, to, lines: compareLines(from.body, to.body) };
}

/**
 * Deletes a Document with all its Versions; only a User may. Refused while it has children: they are moved or
 * deleted first. Its siblings after it close the gap.
 */
export async function deleteDocument({ db }: Context, actor: Caller, documentId: string): Promise<void> {
  await transaction(db, async (tx) => {
    const document = await lockDocument(tx, actor, documentId, { tree: true });
    if (!document) throw documentNotFound();
    if (actor.kind === "agent") {
      throw new ApiError(403, "agent_not_allowed", `${actor.name} is an Agent, and only a User can delete a Document.`, {
        rule: "Only a User deletes a Document, so an agent can't remove knowledge.",
        advice: `Leave the Document as it is, or edit it; ask ${ownerName(actor)}, ${actor.name}'s Owner, if it should go.`,
      });
    }
    const children = await childCount(tx, document);
    if (children > 0) {
      throw new ApiError(
        409,
        "document_has_children",
        `This Document has ${children} ${children === 1 ? "child" : "children"}; move or delete them first.`,
        {
          rule: "A Document with children isn't deleted, so nothing under it is lost with it.",
          advice: "Move its children under another parent or to the top of the page tree, or delete them, first.",
        },
      );
    }
    await tx.query("delete from documents where id = $1", [document.id]);
    await shiftSiblings(tx, document, document.parentId, document.position + 1, -1);
  });
}
