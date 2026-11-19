import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
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

async function insertVersion(
  tx: Tx,
  document: { id: string; workspaceId: string },
  number: number,
  content: { title: string; body: string },
  actor: Caller,
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

/** Creates a Document in the page tree, last among its siblings, at Version 1 by its Actor. */
export async function createDocument(
  { db, clock }: Context,
  actor: Caller,
  tree: Tree,
  input: { title: string; body: string },
): Promise<Document> {
  return transaction(db, async (tx) => {
    await lockTree(tx, tree);
    const now = clock.now();
    const { rows } = await tx.query<{ id: string }>(
      `insert into documents (workspace_id, project_id, parent_id, position, version, created_at)
       values ($1, $2, null,
         (select count(*) from documents where workspace_id = $1 and project_id is not distinct from $2 and parent_id is null),
         1, $3)
       returning id`,
      [tree.workspaceId, tree.projectId, now],
    );
    const id = rows[0]!.id;
    await insertVersion(tx, { id, workspaceId: tree.workspaceId }, 1, input, actor, now);
    return (await findDocument(tx, actor, id))!;
  });
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

/** The Document's row, locked until the transaction ends, so saves of it queue up. */
async function lockDocument(tx: Tx, viewer: Viewer, documentId: string) {
  if (!isUuid(documentId)) return undefined;
  const view = inView(viewer, "documents.workspace_id", "$2");
  const { rows } = await tx.query<Tree & { id: string; version: number; parentId: string | null; position: number }>(
    `select id, workspace_id as "workspaceId", project_id as "projectId", parent_id as "parentId", position, version
     from documents where id = $1 and ${view.sql} for update`,
    [documentId, view.value],
  );
  return rows[0];
}

export interface DocumentEdit {
  /** The number of the Version the save is based on; needed for a new title or body. */
  baseVersion?: number;
  title?: string;
  body?: string;
}

/**
 * Saves a Document. A new title or body makes the next Version by the Actor, and must be based on the current
 * Version: a save based on an outdated one is refused with the current Version, so its Actor can see what changed.
 */
export async function editDocument(
  { db, clock }: Context,
  actor: Caller,
  documentId: string,
  edit: DocumentEdit,
): Promise<Document> {
  return transaction(db, async (tx) => {
    const document = await lockDocument(tx, actor, documentId);
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
          `This save is based on Version ${edit.baseVersion}, but the Document is at Version ${current.number}.`,
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
