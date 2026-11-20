import { Type } from "typebox";

/**
 * What a Ticket that needs a Run waits for. Kept apart from `runs.ts`, which imports `work/tickets.ts`:
 * Tickets build their schema and columns from it as they load, before `runs.ts` would have finished loading.
 */
export const Waiting = Type.Union(
  [Type.Literal("runnerSlot"), Type.Literal("runnerPaused"), Type.Literal("blocked"), Type.Null()],
  {
    description:
      "What the Ticket waits for before it gets the Run it needs: `runnerSlot` while its Runner already has as many " +
      "Runs as its limit, `runnerPaused` while its Runner's queue is paused by a rate limit (see the Runner's " +
      "`pausedUntil`), `blocked` while a Ticket blocking it or one of its Sub-Tickets is unfinished. " +
      "Null when it needs no Run, or has one.",
  },
);

/** Status kinds whose Tickets count as finished, for what they block and for their parents. */
export const finishedKinds = "('done', 'canceled')";

/**
 * SQL to follow `from`: the unfinished Tickets blocking the Ticket `alias`, as `blockers` with their
 * `relations` row and their `blocker_statuses`, ending in a `where` clause the caller may add to.
 */
export const unfinishedBlockers = (alias: string) =>
  `relations join tickets blockers on blockers.id = relations.ticket_id
     join statuses blocker_statuses on blocker_statuses.id = blockers.status_id
     where relations.kind = 'blocks' and relations.other_ticket_id = ${alias}.id
       and blocker_statuses.kind not in ${finishedKinds}`;

/** SQL that holds while the Ticket `alias` is blocked by an unfinished Ticket or has an unfinished Sub-Ticket. */
export const isBlocked = (alias: string) =>
  `(exists (select 1 from ${unfinishedBlockers(alias)})
    or exists (select 1 from tickets subs join statuses on statuses.id = subs.status_id
      where subs.parent_id = ${alias}.id and statuses.kind not in ${finishedKinds}))`;

/** SQL for what the Ticket `alias` waits for, as `Waiting`. */
export const waitingColumn = (alias: string) =>
  `case when not ${alias}.waits_for_run then null when ${isBlocked(alias)} then 'blocked'
     when exists (select 1 from agents join runners on runners.id = agents.runner_id
       where agents.id = ${alias}.delegate_id and runners.paused_until is not null) then 'runnerPaused'
     else 'runnerSlot' end`;

/**
 * SQL for where the Ticket `alias` stands in its Runner's queue, earliest first: highest Priority, then the
 * one that entered its Status first, then by id so the order is total.
 */
export const queueOrder = (alias: string) => `${alias}.priority, ${alias}.status_entered_at, ${alias}.id`;
