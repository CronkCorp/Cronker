import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { transaction, type Db, type Tx } from "../db.js";
import { ApiError } from "../http/errors.js";
import type { Caller } from "../identity/callers.js";
import type { Viewer } from "../identity/viewers.js";
import { findTicketRow, runOfAgent, ticketNotFound } from "./tickets.js";

/** Markdown a Run writes on its Ticket, such as an investigation's findings; later Runs on the Ticket read it. */
export const Report = Type.Object({
  id: Type.String({ format: "uuid" }),
  ticketId: Type.String({ format: "uuid" }),
  runId: Type.String({ format: "uuid", description: "The Run that wrote it." }),
  agent: Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() }, { description: "The Run's Agent." }),
  title: Type.String(),
  body: Type.String({ description: "Markdown." }),
  createdAt: Type.String({ format: "date-time" }),
});
export type Report = Static<typeof Report>;

type Row = Omit<Report, "createdAt"> & { createdAt: Date };

const columns = `reports.id, reports.ticket_id as "ticketId", reports.run_id as "runId",
  json_build_object('id', agents.id, 'name', agents.name) as agent, reports.title, reports.body,
  reports.created_at as "createdAt"`;

const present = (row: Row): Report => ({ ...row, createdAt: row.createdAt.toISOString() });

async function rowsOf(db: Db | Tx, where: string, param: string): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    `select ${columns} from reports join agents on agents.id = reports.agent_id where ${where} order by reports.seq`,
    [param],
  );
  return rows;
}

/** A Ticket's Reports, oldest first. */
export async function reportsOn(db: Db, viewer: Viewer, ticketId: string): Promise<Report[]> {
  const ticket = await findTicketRow(db, viewer, ticketId);
  if (!ticket) throw ticketNotFound();
  return (await rowsOf(db, "reports.ticket_id = $1", ticket.id)).map(present);
}

/** Records a Report of the Run, in the transaction that locked its Ticket. */
export async function recordReport(
  { clock, live }: Context,
  tx: Tx,
  ticket: { id: string; workspaceId: string; projectId: string },
  run: { id: string; agentId: string },
  input: { title: string; body: string },
): Promise<Report> {
  const { rows } = await tx.query<{ id: string }>(
    `insert into reports (workspace_id, ticket_id, run_id, agent_id, title, body, created_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [ticket.workspaceId, ticket.id, run.id, run.agentId, input.title.trim(), input.body, clock.now()],
  );
  const [report] = await rowsOf(tx, "reports.id = $1", rows[0]!.id);
  live.publish(tx, ticket.workspaceId, {
    type: "report.added",
    projectId: ticket.projectId,
    ticketId: ticket.id,
    reportId: report!.id,
  });
  return present(report!);
}

/** An Agent writes a Report on a Ticket during its own running Run on it; Users write Documents instead. */
export async function writeReport(
  context: Context,
  writer: Caller,
  ticketId: string,
  input: { title: string; body: string },
): Promise<Report> {
  return transaction(context.db, async (tx) => {
    const ticket = await findTicketRow(tx, writer, ticketId, { lock: true });
    if (!ticket) throw ticketNotFound();
    if (writer.kind !== "agent") {
      throw new ApiError(403, "only_runs_report", "Reports are written by Runs; comment on the Ticket instead.");
    }
    const runId = await runOfAgent(tx, writer, ticket);
    return recordReport(context, tx, ticket, { id: runId, agentId: writer.id }, input);
  });
}
