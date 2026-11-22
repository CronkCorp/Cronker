import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import { slugColumn, slugDescription } from "../http/readable.js";
import { requireWrite, type Viewer } from "../identity/viewers.js";
import { findTicketRow, runOfAgent, ticketNotFound } from "../work/tickets.js";
import { insertVersion } from "./documents.js";
import { Mention, mentionsOf } from "../work/mentions.js";
import { markdown, title } from "../work/fields.js";

/**
 * Reports: Documents a Run writes on its Ticket, such as an investigation's findings, listed with the Ticket instead
 * of in a page tree; later Runs on the Ticket read them. Each is a Document of the Ticket's Project, with Versions,
 * whose first Version is by the Run's Agent; a Report shows its current Version.
 */
export const Report = Type.Object({
  id: Type.String({ format: "uuid", description: "Also the Report's Document's id, under which its Versions are read." }),
  ticketId: Type.String({ format: "uuid" }),
  runId: Type.String({ format: "uuid", description: "The Run that wrote it." }),
  agent: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }, { description: "The Run's Agent." }),
  title: Type.String({ description: "Its current Version's." }),
  slug: Type.String({ description: slugDescription }),
  body: Type.String({ description: "Markdown; its current Version's." }),
  createdAt: Type.String({ format: "date-time" }),
  mentions: Type.Array(Mention, {
    description: "The Ticket keys and Term names its body mentions and the Artifacts it embeds that the caller may read.",
  }),
});
export type Report = Static<typeof Report>;

type Row = Omit<Report, "createdAt" | "mentions"> & { createdAt: Date };

const columns = `documents.id, documents.ticket_id as "ticketId", documents.run_id as "runId",
  json_build_object('id', agents.id, 'name', agents.name) as agent, versions.title,
  ${slugColumn("document", "documents.id", "versions.title")} as slug, versions.body,
  documents.created_at as "createdAt"`;

const fromReports = `documents
  join document_versions versions on versions.document_id = documents.id and versions.number = documents.version
  join runs on runs.id = documents.run_id
  join agents on agents.id = runs.agent_id`;

/**
 * SQL for the latest Report on the Ticket whose id is `ticketId` (a column or parameter of the enclosing query),
 * as `{ id, title }` json, or null when it has none: what lists show of a Ticket's Reports.
 */
export const latestReportOf = (ticketId: string) =>
  `(select json_build_object('id', documents.id, 'title', versions.title,
      'slug', ${slugColumn("document", "documents.id", "versions.title")}) from ${fromReports}
    where documents.ticket_id = ${ticketId} order by documents.seq desc limit 1)`;

/** A Report as lists show it, by its id and title. */
export const ReportRef = Type.Object({
  id: Type.String({ format: "uuid" }),
  title: Type.String({ description: "Its current Version's." }),
  slug: Type.String({ description: slugDescription }),
});
export type ReportRef = Static<typeof ReportRef>;

/** Reports as the API shows them, finding the Ticket keys of all their bodies at once. */
async function present(db: Db | Tx, viewer: Viewer, rows: Row[]): Promise<Report[]> {
  const mentions = await mentionsOf(db, viewer, "document", rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString(), mentions: mentions.get(row.id)! }));
}

async function rowsOf(db: Db | Tx, where: string, param: string): Promise<Row[]> {
  const { rows } = await db.query<Row>(`select ${columns} from ${fromReports} where ${where} order by documents.seq`, [
    param,
  ]);
  return rows;
}

/** A Ticket's Reports, oldest first. */
export async function reportsOn(db: Db, viewer: Viewer, ticketId: string): Promise<Report[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  return present(db, viewer, await rowsOf(db, "documents.ticket_id = $1", ticket.id));
}

/**
 * Records a Report of the Run, at Version 1 by its Agent, in the transaction that locked its Ticket; given a Viewer,
 * returns it as the Viewer sees it.
 */
export async function recordReport(
  { clock, live }: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string; projectId: string },
  run: { id: string; agentId: string },
  input: { title: string; body: string },
  viewer?: Viewer,
): Promise<Report | undefined> {
  const now = clock.now();
  const { rows } = await tx.query<{ id: string }>(
    `insert into documents (workspace_id, project_id, ticket_id, run_id, version, created_at)
     values ($1, $2, $3, $4, 1, $5) returning id`,
    [ticket.workspaceId, ticket.projectId, ticket.id, run.id, now],
  );
  const id = rows[0]!.id;
  await insertVersion(tx, { id, workspaceId: ticket.workspaceId }, 1, input, { kind: "agent", id: run.agentId }, now);
  const [report] = await rowsOf(tx, "documents.id = $1", id);
  live.publish(tx, ticket.workspaceId, {
    type: "report.added",
    projectId: ticket.projectId,
    ticketId: ticket.id,
    reportId: report!.id,
  });
  return viewer && (await present(tx, viewer, [report!]))[0];
}

/** The write-a-Report route's body. */
export const ReportCreate = Type.Object({
  title: title("A short title, such as `Findings`."),
  body: markdown(500_000),
});
export type ReportCreate = Static<typeof ReportCreate>;

/** An Agent writes a Report on a Ticket during its own running Run on it; Users comment instead. */
export async function writeReport(
  context: Context,
  writer: Caller,
  ticketId: string,
  input: ReportCreate,
): Promise<Report> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, writer, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    if (writer.kind !== "agent") {
      throw new ApiError(403, "only_runs_report", "Reports are written by Runs; comment on the Ticket instead.");
    }
    await requireWrite(tx, writer, ticket);
    const runId = await runOfAgent(tx, writer, ticket);
    return (await recordReport(context, tx, ticket, { id: runId, agentId: writer.id }, input, writer))!;
  });
}
