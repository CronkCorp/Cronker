import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { slugColumn } from "../http/readable.js";
import { inReach, userViewer } from "../identity/viewers.js";
import { DecisionStatus } from "../knowledge/decisions.js";

/** The Decision, Term, Document or Artifact a New knowledge item is about, as it is now. */
export const KnowledgeSubject = Type.Object({
  kind: Type.Union([Type.Literal("decision"), Type.Literal("term"), Type.Literal("document"), Type.Literal("artifact")]),
  id: Type.String({ format: "uuid" }),
  title: Type.String({ description: "A Decision's, Document's or Artifact's title, or a Term's name." }),
  projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "Null for the Workspace's own." }),
  projectKey: Type.Union([Type.String(), Type.Null()], { description: "Its Project's key; null for the Workspace's own." }),
  slug: Type.Union([Type.String(), Type.Null()], { description: "A Document's or Artifact's slug; null for the other kinds." }),
  number: Type.Union([Type.Integer(), Type.Null()], { description: "A Decision's number; null for the other kinds." }),
  status: Type.Union([DecisionStatus, Type.Null()], { description: "A Decision's status; null for the other kinds." }),
});
export type KnowledgeSubject = Static<typeof KnowledgeSubject>;

/**
 * A Decision, Term, Document or Artifact an Agent created, waiting for the User it was routed to, the Assignee of the
 * Ticket of the Run it was created in or else the Agent's Owner, until they dismiss it; a Decision also until its
 * status leaves proposed.
 */
export const KnowledgeItem = Type.Object({
  kind: Type.Literal("knowledge"),
  id: Type.String({ format: "uuid", description: "The item's own id, which dismissing it names." }),
  subject: KnowledgeSubject,
  agent: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }, { description: "The Agent that created it." }),
  run: Type.Union([Type.String({ format: "uuid" }), Type.Null()], { description: "The Run it was created in, if the Agent named one." }),
  since: Type.String({ format: "date-time", description: "When it began waiting: when the Agent created it." }),
});
export type KnowledgeItem = Static<typeof KnowledgeItem>;

/**
 * The New knowledge waiting for the User in the Workspace, oldest first: only what they may read, and none of an
 * archived Project.
 */
export async function knowledgeItemsOf(db: Db, userId: string, workspaceId: string): Promise<KnowledgeItem[]> {
  const readable = inReach(userViewer(userId), { project: "subjects.project_id", workspace: "subjects.workspace_id" }, "$3");
  const { rows } = await db.query<Omit<KnowledgeItem, "since"> & { since: Date }>(
    `with subjects as (
       select notices.id, notices.created_at, notices.agent_id, notices.run_id, 'decision' as kind, decisions.id as subject_id,
         decisions.workspace_id, decisions.project_id, versions.title, null::text as slug, decisions.number,
         versions.status::text as status
       from knowledge_notices notices join decisions on decisions.id = notices.decision_id
       join decision_versions versions on versions.decision_id = decisions.id and versions.number = decisions.version
       where notices.workspace_id = $1 and notices.user_id = $2 and notices.dismissed_at is null and versions.status = 'proposed'
       union all
       select notices.id, notices.created_at, notices.agent_id, notices.run_id, 'term', terms.id,
         terms.workspace_id, terms.project_id, versions.name, null, null, null
       from knowledge_notices notices join terms on terms.id = notices.term_id
       join term_versions versions on versions.term_id = terms.id and versions.number = terms.version
       where notices.workspace_id = $1 and notices.user_id = $2 and notices.dismissed_at is null
       union all
       select notices.id, notices.created_at, notices.agent_id, notices.run_id, 'document', documents.id,
         documents.workspace_id, documents.project_id, versions.title, ${slugColumn("document", "documents.id", "versions.title")}, null, null
       from knowledge_notices notices join documents on documents.id = notices.document_id
       join document_versions versions on versions.document_id = documents.id and versions.number = documents.version
       where notices.workspace_id = $1 and notices.user_id = $2 and notices.dismissed_at is null
       union all
       select notices.id, notices.created_at, notices.agent_id, notices.run_id, 'artifact', artifacts.id,
         artifacts.workspace_id, artifacts.project_id, versions.title, ${slugColumn("artifact", "artifacts.id", "versions.title")}, null, null
       from knowledge_notices notices join artifacts on artifacts.id = notices.artifact_id
       join artifact_versions versions on versions.artifact_id = artifacts.id and versions.number = artifacts.version
       where notices.workspace_id = $1 and notices.user_id = $2 and notices.dismissed_at is null
     )
     select subjects.id, 'knowledge' as kind,
       json_build_object('kind', subjects.kind, 'id', subjects.subject_id, 'title', subjects.title,
         'projectId', subjects.project_id, 'projectKey', projects.key, 'slug', subjects.slug, 'number', subjects.number, 'status', subjects.status) as subject,
       json_build_object('id', agents.id, 'name', agents.name) as agent, subjects.run_id as run, subjects.created_at as since
     from subjects join agents on agents.id = subjects.agent_id
     left join projects on projects.id = subjects.project_id
     -- An archived Project's knowledge waits on nobody until it is unarchived.
     where projects.archived_at is null and ${readable.sql}
     order by subjects.created_at, subjects.id`,
    [workspaceId, userId, readable.value],
  );
  return rows.map(({ since, ...row }) => ({ ...row, since: since.toISOString() }));
}

/** Where the item's knowledge is shown in the web client, under the Workspace's slug. */
export function knowledgePath(workspaceSlug: string, subject: KnowledgeSubject): string {
  const part = encodeURIComponent;
  const place = subject.projectKey === null ? `/${workspaceSlug}` : `/${workspaceSlug}/projects/${part(subject.projectKey)}`;
  switch (subject.kind) {
    case "decision":
      return `${place}/decisions/${subject.number}`;
    case "term":
      return `${place}/glossary/${part(subject.title)}`;
    case "document":
      return `/${workspaceSlug}/documents/${part(subject.slug ?? subject.id)}`;
    case "artifact":
      return `/${workspaceSlug}/artifacts/${part(subject.slug ?? subject.id)}`;
  }
}

/** Clears a New knowledge item from its User's Inbox; refused as not found for anyone else's. */
export async function dismissKnowledge({ db, clock, live }: Context, userId: string, noticeId: string): Promise<void> {
  await transaction(db, async (tx) => {
    const { rows } = isUuid(noticeId)
      ? await tx.query<{ workspaceId: string }>(
          `update knowledge_notices set dismissed_at = coalesce(dismissed_at, $3) where id = $1 and user_id = $2
           returning workspace_id as "workspaceId"`,
          [noticeId, userId, clock.now()],
        )
      : { rows: [] };
    const notice = rows[0];
    if (!notice) throw new ApiError(404, "not_found", "No New knowledge item with that id waits for you.");
    live.publish(tx, notice.workspaceId, { type: "inbox.changed" }, { users: [userId] });
  });
}
