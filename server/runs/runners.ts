import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import type { Db } from "../db.js";
import { afterCommit, transaction } from "../db.js";
import { ApiError } from "../http/errors.js";
import { isUuid } from "../http/ids.js";
import { startWaitingRuns } from "./runs.js";

/** A Runner a User set up: a way for Cronk to start Runs of their Agents with their own credentials. */
export const RunnerRecord = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  kind: Type.String({ description: "Which of this Cronk's kinds of Runner starts its Runs." }),
  limit: Type.Integer({
    minimum: 1,
    description: "How many Runs it keeps running at once; Tickets needing a Run beyond it wait for a slot.",
  }),
  createdAt: Type.String({ format: "date-time" }),
});
export type RunnerRecord = Static<typeof RunnerRecord>;

type Row = Omit<RunnerRecord, "createdAt"> & { createdAt: Date };
const columns = `id, name, kind, run_limit as limit, created_at as "createdAt"`;
const present = (row: Row): RunnerRecord => ({ ...row, createdAt: row.createdAt.toISOString() });

/** The User's own Runners, oldest first. */
export async function runnersOf(db: Db, userId: string): Promise<RunnerRecord[]> {
  const { rows } = await db.query<Row>(`select ${columns} from runners where owner_id = $1 order by created_at, id`, [userId]);
  return rows.map(present);
}

export async function createRunner(
  { db, clock, runners }: Context,
  userId: string,
  input: { name: string; kind: string },
): Promise<RunnerRecord> {
  if (!Object.hasOwn(runners, input.kind)) {
    const kinds = Object.keys(runners);
    throw new ApiError(
      400,
      "unknown_runner_kind",
      `This Cronk has no Runner of the kind ${input.kind}; ${kinds.length ? `it has ${kinds.join(", ")}` : "it has none yet"}.`,
    );
  }
  const { rows } = await db.query<Row>(
    `insert into runners (owner_id, kind, name, created_at) values ($1, $2, $3, $4) returning ${columns}`,
    [userId, input.kind, input.name.trim(), clock.now()],
  );
  return present(rows[0]!);
}

/** Sets how many Runs one of the User's own Runners keeps running at once; a higher limit starts waiting Tickets. */
export async function setRunnerLimit(context: Context, userId: string, runnerId: string, limit: number): Promise<RunnerRecord> {
  return transaction(context.db, async (tx) => {
    const { rows } = isUuid(runnerId)
      ? await tx.query<Row>(`update runners set run_limit = $3 where id = $1 and owner_id = $2 returning ${columns}`, [
          runnerId,
          userId,
          limit,
        ])
      : { rows: [] };
    if (!rows[0]) throw new ApiError(404, "not_found", "You have no such Runner.");
    afterCommit(tx, () => startWaitingRuns(context, runnerId));
    return present(rows[0]);
  });
}
