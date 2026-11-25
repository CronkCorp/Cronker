import { Type } from "typebox";

/**
 * What a Ticket that needs a Run waits for. Kept apart from `runs.ts`, which imports `work/tickets.ts`:
 * Tickets build their schema and columns from it as they load, before `runs.ts` would have finished loading.
 */
export const Waiting = Type.Union(
  [
    Type.Literal("runnerSlot"),
    Type.Literal("runnerPaused"),
    Type.Literal("runnerOffline"),
    Type.Literal("machineModel"),
    Type.Literal("blocked"),
    Type.Literal("archived"),
    Type.Null(),
  ],
  {
    description:
      "What the Ticket waits for before it gets the Run it needs: `runnerSlot` while its Runner already has as many " +
      "Runs as its limit, `runnerPaused` while its Runner's queue is paused by a rate limit (see the Runner's " +
      "`pausedUntil`), `runnerOffline` while its Runner is a `local` one with no " +
      "Machine serving it connected (see the Runner's `offlineSince`), `machineModel` while the Machine model its Step's " +
      "label is mapped to (see `waitingModel`) is set up on a Machine serving its Runner but up with room on none of " +
      "those connected: the Runner's queue passes it by meanwhile, `blocked` while a Ticket blocking it or one of its Sub-Tickets is unfinished, `archived` while " +
      "its Project is archived: nothing starts for it, and the Runner's queue passes it by, until an Admin unarchives it. " +
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

/** SQL that holds while the Ticket `alias` is in an archived Project. */
export const inArchivedProject = (alias: string) =>
  `exists (select 1 from projects archived where archived.id = ${alias}.project_id and archived.archived_at is not null)`;

/**
 * SQL that holds while the Runner `alias` is a `local` Runner with no Machine serving it connected: offline, so its
 * Tickets wait rather than start, until one connects.
 */
export const runnerOffline = (alias: string) =>
  `(${alias}.kind = 'local' and not exists (select 1 from machine_runners
     join machines on machines.id = machine_runners.machine_id
     where machine_runners.runner_id = ${alias}.id and machines.revoked_at is null and machines.connections > 0))`;

/**
 * SQL for the Machine model the label (an SQL expression) is mapped to on the Runner `runners`, matched ignoring case;
 * null for an unmapped label, which needs Claude.
 */
export const mappedModelOf = (runners: string, label: string) =>
  `(select m->>'model' from jsonb_array_elements(${runners}.machine_models) m
    where lower(m->>'label') = lower(btrim(${label})) limit 1)`;

/** SQL for the label of the Step of the Ticket `alias`'s Status: the label its next Run runs on. */
export const stepLabel = (alias: string) => `(select steps.model from steps where steps.status_id = ${alias}.status_id)`;

/**
 * SQL that holds while the Machine model `model` (an SQL expression) leaves a Run of the Runner `runners` waiting: a
 * Machine serving the Runner has it set up, paired, but no connected one has it up with room. Room counts the running
 * Runs needing it, claimed on it or waiting to be claimed through a Runner those Machines serve, against the sum of
 * its limits on the connected Machines serving the Runner that have it up. With none set up it doesn't wait: its Run
 * is refused.
 */
export const machineModelWaits = (runners: string, model: string) =>
  `(exists (select 1 from machine_runners set_up_on join machines set_up on set_up.id = set_up_on.machine_id
      where set_up_on.runner_id = ${runners}.id and set_up.revoked_at is null
        and set_up.announced_models @> jsonb_build_array(jsonb_build_object('name', ${model})))
    and (select count(*) from runs needing join runners needing_runners on needing_runners.id = needing.runner_id
         where needing.state = 'running'
           and needing.runner_id in (select others.runner_id from machine_runners serving
             join machine_runners others on others.machine_id = serving.machine_id where serving.runner_id = ${runners}.id)
           and case when exists (select 1 from local_runs where local_runs.run_id = needing.id) then needing.machine_model
             else ${mappedModelOf("needing_runners", "needing.model")} end = ${model})
      >= coalesce((select sum((offered->>'limit')::int) from machine_runners up_on
           join machines up on up.id = up_on.machine_id cross join jsonb_array_elements(up.announced_models) offered
           where up_on.runner_id = ${runners}.id and up.revoked_at is null and up.connections > 0
             and offered->>'name' = ${model} and (offered->>'up')::boolean), 0))`;

/**
 * SQL for the Machine model the Ticket `alias` would wait for now through its Delegate's Runner: the one its Step's
 * label is mapped to, while it has no room. Null otherwise, and for a Runner that isn't `local`.
 */
const modelWaitedFor = (alias: string) =>
  `(select waited.model from agents join runners on runners.id = agents.runner_id
     cross join lateral (select ${mappedModelOf("runners", stepLabel(alias))} as model) waited
     where agents.id = ${alias}.delegate_id and runners.kind = 'local' and waited.model is not null
       and ${machineModelWaits("runners", "waited.model")})`;

/** SQL for what the Ticket `alias` waits for, as `Waiting`. */
export const waitingColumn = (alias: string) =>
  `case when not ${alias}.waits_for_run then null when ${inArchivedProject(alias)} then 'archived'
     when ${isBlocked(alias)} then 'blocked'
     when exists (select 1 from agents join runners on runners.id = agents.runner_id
       where agents.id = ${alias}.delegate_id and ${runnerOffline("runners")}) then 'runnerOffline'
     when exists (select 1 from agents join runners on runners.id = agents.runner_id
       where agents.id = ${alias}.delegate_id and runners.paused_until is not null) then 'runnerPaused'
     when ${modelWaitedFor(alias)} is not null then 'machineModel'
     else 'runnerSlot' end`;

/** SQL for the Machine model the Ticket `alias` waits for while its `waiting` is `machineModel`; null otherwise. */
export const waitingModelColumn = (alias: string) =>
  `case when (${waitingColumn(alias)}) = 'machineModel' then ${modelWaitedFor(alias)} end`;

/** SQL that holds while the Ticket `alias` waits for a Machine model with no room, whatever else it waits for. */
export const waitsForMachineModel = (alias: string) => `(${modelWaitedFor(alias)} is not null)`;

/**
 * SQL for where the Ticket `alias` stands in its Runner's queue, earliest first: highest Priority, then the
 * one that entered its Status first, then by id so the order is total.
 */
export const queueOrder = (alias: string) => `${alias}.priority, ${alias}.status_entered_at, ${alias}.id`;
