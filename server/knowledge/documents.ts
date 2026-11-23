import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { forgetAttachments } from "../attachments/attachments.js";
import { afterCommit, transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { slugColumn, slugDescription } from "../http/readable.js";
import { ownerName } from "../agents/tokens.js";
import type { Caller } from "../identity/callers.js";
import { inReach, requireWrite, type Viewer } from "../identity/viewers.js";
import { Actor, actorColumn } from "../work/actors.js";
import { creatingRun, noticeKnowledge } from "../inbox/knowledge-notices.js";
import type { Live } from "../live/live.js";
import { ComparedLine, compareLines } from "./compare.js";
import type { Place } from "./places.js";
import { findSection, pathOf, replaceSection, sectionsOf, sectionText, type Section } from "./sections.js";
import { outdatedVersion } from "./versions.js";
import { indexMentions, Mention, mentionsOfOne } from "../work/mentions.js";
import { nullable, title } from "../work/fields.js";

/**
 * Documents: written knowledge kept as Markdown in the page tree of a Project or of the Workspace, or, as a Report,
 * on a Ticket. Each save makes a Version recording its Actor; the Document shows its current Version.
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
    description: "The Project whose page tree holds it, or null for the Workspace's; a Report's is its Ticket's Project.",
  }),
  ticketId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Ticket it is a Report on, listed with the Ticket instead of in a page tree; null in a page tree.",
  }),
  runId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Run that wrote it, for a Report; otherwise null.",
  }),
  parentId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], {
    description: "The Document above it in the same page tree, or null at the top; null for a Report.",
  }),
  position: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], {
    description: "Its place among its siblings, counting from 0; null for a Report.",
  }),
  title: Type.String(),
  slug: Type.String({ description: slugDescription }),
  body: Type.String({ description: "Markdown." }),
  version: Type.Object(Version.properties, { description: "The current Version, which a save names as its base." }),
  mentions: Type.Array(Mention, {
    description: "The Ticket and Decision keys and Term names its body mentions and the Artifacts it embeds that the caller may read.",
  }),
});
export type Document = Static<typeof Document>;

/** Which page tree a Document is in: a Project's, or the Workspace's when `projectId` is null. */
export type Tree = Place;

type Row = Omit<Document, "version" | "mentions"> & { version: Omit<Version, "savedAt"> & { savedAt: string } };

const columns = `documents.id, documents.workspace_id as "workspaceId", documents.project_id as "projectId",
  documents.ticket_id as "ticketId", documents.run_id as "runId", documents.parent_id as "parentId", documents.position, versions.title,
  ${slugColumn("document", "documents.id", "versions.title")} as slug, versions.body,
  json_build_object('number', versions.number, 'title', versions.title,
    'actor', ${actorColumn("users", "agents")}, 'savedAt', versions.saved_at) as version`;

const fromDocuments = `documents
  join document_versions versions on versions.document_id = documents.id and versions.number = documents.version
  left join users on users.id = versions.actor_user_id
  left join agents on agents.id = versions.actor_agent_id`;

const present = (row: Row): Omit<Document, "mentions"> => ({
  ...row,
  version: { ...row.version, savedAt: new Date(row.version.savedAt).toISOString() },
});

/** A Document in the Viewer's view; otherwise nothing, as if it didn't exist. */
export async function findDocument(db: Db | Tx, viewer: Viewer, documentId: string): Promise<Document | undefined> {
  if (!isUuid(documentId)) return undefined;
  const view = inReach(viewer, { project: "documents.project_id", workspace: "documents.workspace_id" }, "$2");
  const { rows } = await db.query<Row>(`select ${columns} from ${fromDocuments} where documents.id = $1 and ${view.sql}`, [
    documentId,
    view.value,
  ]);
  return rows[0] && { ...present(rows[0]), mentions: await mentionsOfOne(db, viewer, "document", rows[0].id) };
}

export function documentNotFound(): ApiError {
  return new ApiError(404, "not_found", "No such Document.");
}

/** Keeps a query to page-tree Documents: a Report is listed with its Ticket instead. */
const inAPageTree = "ticket_id is null";

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
  // Each Version saved becomes the current one, whose Mentions count.
  await indexMentions(tx, "document", document, content.body);
}

export const DocumentSummary = Type.Omit(Document, ["body", "mentions"]);
export type DocumentSummary = Static<typeof DocumentSummary>;

/** A page tree's Documents in tree order: each right after its parent, siblings by their place; without bodies. */
export async function treeOf(db: Db, tree: Tree): Promise<DocumentSummary[]> {
  const { rows } = await db.query<Row>(
    `with recursive ordered (id, path) as (
       select id, array[position] from documents
       where workspace_id = $1 and project_id is not distinct from $2 and parent_id is null and ${inAPageTree}
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
       and ${inAPageTree} and id is distinct from $4`,
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
         where id = $1 and workspace_id = $2 and project_id is not distinct from $3 and ${inAPageTree}`,
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
       and ${inAPageTree} and position >= $4 and id is distinct from $6`,
    [tree.workspaceId, tree.projectId, parentId, from, by, except],
  );
}

const Body = Type.String({ maxLength: 500_000, description: "Markdown." });
const ParentId = nullable(Type.String(), "A Document of the same page tree to sit under, or null for the top.");
const Position = Type.Integer({
  minimum: 0,
  description: "A place among its siblings, counting from 0; last when left out or past the end.",
});

/** The create-a-Document route's body. */
export const DocumentCreate = Type.Object({
  title: title(),
  body: Type.Optional(Body),
  parentId: Type.Optional(ParentId),
  position: Type.Optional(Position),
  runId: Type.Optional(
    Type.String({
      description:
        "For an Agent, its running Run the Document is created in: its New knowledge item waits for the Assignee of the Run's " +
        "Ticket rather than the Agent's Owner.",
    }),
  ),
});
export type DocumentCreate = Static<typeof DocumentCreate>;

/**
 * Creates a Document in the page tree, under a parent of the same tree or at the top, at a place among its
 * siblings or last, at Version 1 by its Actor.
 */
export async function createDocument(
  { db, clock, live }: Context,
  actor: Caller,
  tree: Tree,
  input: DocumentCreate & { body: string },
): Promise<Document> {
  return transaction(db, async (tx) => {
    await requireWrite(tx, actor, tree);
    await lockTree(tx, tree);
    const parentId = input.parentId ?? null;
    if (parentId) await requireParentInTree(tx, tree, parentId);
    const run = await creatingRun(tx, actor, input.runId, "a Document");
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
    await noticeKnowledge(tx, live, actor, { kind: "document", id, workspaceId: tree.workspaceId }, run, now);
    documentChanged(live, tx, { ...tree, id, ticketId: null });
    return (await findDocument(tx, actor, id))!;
  });
}

/**
 * Moves a Document under another parent of its page tree, or to the top, at a place among its new siblings or
 * last; or to another place among its siblings. Refused under itself or one of its own descendants. Takes the
 * Document locked with its page tree.
 */
async function moveDocument(tx: Tx, document: Placed, to: { parentId?: string | null; position?: number }): Promise<void> {
  if (!isInPageTree(document)) {
    throw new ApiError(409, "report_outside_tree", "A Report is listed with its Ticket, so it doesn't move in a page tree.", {
      rule: "A Report is listed with its Ticket instead of in a page tree.",
      advice: "Leave the Report on its Ticket; to keep what it says in a page tree, create a Document there from it.",
    });
  }
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
type Placed = Tree & { id: string; version: number; parentId: string | null; position: number | null; ticketId: string | null };

/** Whether the Document sits in a page tree, with a place there, rather than being a Report on a Ticket. */
const isInPageTree = (document: Placed): document is Placed & { ticketId: null; position: number } =>
  document.ticketId === null;

/**
 * Tells the Workspace's streams that a Document changed or went: one in a page tree so its tree and page show it,
 * a Report so its Ticket does.
 */
function documentChanged(live: Live, tx: Tx, document: Tree & { id: string; ticketId: string | null }): void {
  if (document.ticketId === null) {
    live.publish(tx, document.workspaceId, { type: "document.changed", projectId: document.projectId, documentId: document.id });
    return;
  }
  live.publish(tx, document.workspaceId, {
    type: "report.changed",
    projectId: document.projectId!,
    ticketId: document.ticketId,
    reportId: document.id,
  });
}

/**
 * The Document's row, locked until the transaction ends, so writes to it queue up. With `tree`, its page tree's
 * lock is taken first: every write holding both takes the tree's before the row's, so none waits on the other.
 */
async function lockDocument(tx: Tx, viewer: Viewer, documentId: string, { tree = false } = {}): Promise<Placed | undefined> {
  if (!isUuid(documentId)) return undefined;
  const view = inReach(viewer, { project: "documents.project_id", workspace: "documents.workspace_id" }, "$2");
  const select = `select id, workspace_id as "workspaceId", project_id as "projectId", parent_id as "parentId", position,
    ticket_id as "ticketId", version from documents where id = $1 and ${view.sql}`;
  if (tree) {
    // A Document never changes page tree, so the one read before locking is the one it is in.
    const found = (await tx.query<Placed>(select, [documentId, view.value])).rows[0];
    if (!found) return undefined;
    await lockTree(tx, found);
  }
  return (await tx.query<Placed>(`${select} for update`, [documentId, view.value])).rows[0];
}

/**
 * Saves the Document's next Version by the Actor, with the content made from its current Version, which the save
 * must be based on: one based on an outdated Version is refused with the current Version.
 */
async function saveNextVersion(
  tx: Tx,
  document: Placed,
  actor: Caller,
  baseVersion: number | undefined,
  now: Date,
  content: (current: VersionWithBody) => { title: string; body: string },
): Promise<void> {
  if (baseVersion === undefined) {
    throw new ApiError(400, "base_version_needed", "A save names the Version it's based on, as `baseVersion`.", {
      rule: "A save names the Version it's based on, so it never overwrites a change its Actor hasn't seen.",
      advice: `Read the Document and save again with \`baseVersion\` set to its current Version's number.`,
    });
  }
  const current = (await versionOf(tx, document.id, document.version))!;
  if (baseVersion !== current.number) throw outdatedVersion("Document", current, baseVersion);
  const number = current.number + 1;
  await insertVersion(tx, document, number, content(current), actor, now);
  await tx.query("update documents set version = $2 where id = $1", [document.id, number]);
}

/** The save-rename-or-move route's body. */
export const DocumentEdit = Type.Object({
  baseVersion: Type.Optional(Type.Integer({ minimum: 1, description: "The Version the save is based on." })),
  title: Type.Optional(title()),
  body: Type.Optional(Body),
  parentId: Type.Optional(ParentId),
  position: Type.Optional(Position),
});
export type DocumentEdit = Static<typeof DocumentEdit>;

/**
 * Saves or moves a Document. A new title or body makes the next Version by the Actor, and must be based on the
 * current Version: a save based on an outdated one is refused with the current Version, so its Actor can see what
 * changed. Moving it makes no Version.
 */
export async function editDocument(
  { db, clock, live }: Context,
  actor: Caller,
  documentId: string,
  edit: DocumentEdit,
): Promise<Document> {
  return transaction(db, async (tx) => {
    const moving = edit.parentId !== undefined || edit.position !== undefined;
    const document = await lockDocument(tx, actor, documentId, { tree: moving });
    if (!document) throw documentNotFound();
    await requireWrite(tx, actor, document);
    if (edit.title !== undefined || edit.body !== undefined) {
      await saveNextVersion(tx, document, actor, edit.baseVersion, clock.now(), (current) => ({
        title: edit.title ?? current.title,
        body: edit.body ?? current.body,
      }));
    }
    if (moving) await moveDocument(tx, document, edit);
    documentChanged(live, tx, document);
    return (await findDocument(tx, actor, document.id))!;
  });
}

export const DocumentSection = Type.Object({
  documentId: Type.String({ format: "uuid" }),
  path: Type.String({ description: "Its heading's path: the texts of the headings it sits under and its own, joined by `/`." }),
  level: Type.Integer({ minimum: 1, maximum: 6, description: "Its heading's level: 1 for `#`." }),
  body: Type.String({
    description: "Markdown: its heading and everything up to the next heading of the same or a higher level.",
  }),
  version: Type.Object(Version.properties, { description: "The Document's current Version, which a replace names as its base." }),
});
export type DocumentSection = Static<typeof DocumentSection>;

function presentSection(document: Document, markdown: string, section: Section): DocumentSection {
  return {
    documentId: document.id,
    path: pathOf(section),
    level: section.level,
    body: sectionText(markdown, section),
    version: document.version,
  };
}

/**
 * One Section of a Document at its current Version, named by its heading's text or by a path joining headings with
 * `/`; refused when several Sections match or none does.
 */
export async function readSection(db: Db, viewer: Viewer, documentId: string, name: string): Promise<DocumentSection> {
  const document = await findDocument(db, viewer, documentId);
  if (!document) throw documentNotFound();
  return presentSection(document, document.body, findSection(document.body, name));
}

/** A Section's name, as a read or a replace gives it. */
export const SectionName = Type.String({
  minLength: 1,
  maxLength: 1000,
  description: "Its heading's text, or a path joining headings with `/`, such as `Install/Linux`.",
});

/** The replace-a-Section route's body. */
export const SectionReplace = Type.Object({
  section: SectionName,
  baseVersion: Type.Integer({ minimum: 1, description: "The Version the replace is based on." }),
  body: Type.String({
    maxLength: 500_000,
    description: "Markdown: the Section's heading, of its own level, and everything under it.",
  }),
});
export type SectionReplace = Static<typeof SectionReplace>;

/**
 * Replaces one Section of a Document, making its next Version by the Actor based on the given one, as a whole save
 * does. The new body keeps the Section's heading level; the rest of the Document stays as it was.
 */
export async function replaceDocumentSection(
  { db, clock, live }: Context,
  actor: Caller,
  documentId: string,
  input: SectionReplace,
): Promise<DocumentSection> {
  return transaction(db, async (tx) => {
    const document = await lockDocument(tx, actor, documentId);
    if (!document) throw documentNotFound();
    await requireWrite(tx, actor, document);
    let start = 0;
    await saveNextVersion(tx, document, actor, input.baseVersion, clock.now(), (current) => {
      const section = findSection(current.body, input.section);
      start = section.start;
      return { title: current.title, body: replaceSection(current.body, section, input.body) };
    });
    documentChanged(live, tx, document);
    const saved = (await findDocument(tx, actor, document.id))!;
    const replaced = sectionsOf(saved.body).find((section) => section.start === start)!;
    return presentSection(saved, saved.body, replaced);
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
 * Deletes a Document with all its Versions, Attachments and Comments; only a User may. Refused while it has children: they are
 * moved or deleted first. Its siblings after it close the gap, and it drops out of the Tickets linking it.
 */
export async function deleteDocument(context: Context, actor: Caller, documentId: string): Promise<void> {
  const { db, live } = context;
  await transaction(db, async (tx) => {
    const document = await lockDocument(tx, actor, documentId, { tree: true });
    if (!document) throw documentNotFound();
    await requireWrite(tx, actor, document);
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
    // Its Attachments go with it, its Comments too with the files attached to them; replies before what they answer.
    const attached = await tx.query<{ id: string }>(
      `delete from attachments
       where document_id = $1 or comment_id in (select id from comments where document_id = $1) returning id`,
      [document.id],
    );
    await tx.query("update comments set reply_to_id = null where document_id = $1", [document.id]);
    await tx.query("delete from comments where document_id = $1", [document.id]);
    afterCommit(tx, () => forgetAttachments(context, attached.rows.map((row) => row.id)));
    // It drops out of its links: the Tickets linking it show the change.
    const linking = await tx.query<{ ticketId: string; projectId: string }>(
      `select tickets.id as "ticketId", tickets.project_id as "projectId"
       from linked_documents join tickets on tickets.id = linked_documents.ticket_id
       where linked_documents.document_id = $1 order by linked_documents.seq`,
      [document.id],
    );
    for (const { ticketId, projectId } of linking.rows) {
      live.publish(tx, document.workspaceId, { type: "ticket.changed", projectId, ticketId });
    }
    await tx.query("delete from documents where id = $1", [document.id]);
    if (isInPageTree(document)) await shiftSiblings(tx, document, document.parentId, document.position + 1, -1);
    documentChanged(live, tx, document);
  });
}

/** Where a saved Document, or Report, is kept: its page tree's Project or Workspace, a Report's being its Ticket's Project. */
export async function placeOfDocument(db: Db, documentId: string): Promise<Place> {
  const { rows } = await db.query<Place>(
    `select workspace_id as "workspaceId", project_id as "projectId" from documents where id = $1`,
    [documentId],
  );
  return rows[0]!;
}
