import { Type } from "typebox";

/**
 * Where a Run stands. Kept apart from `runs.ts`, which imports `work/tickets.ts`: Tickets build
 * their schema from it as they load, before `runs.ts` would have finished loading.
 */
export const runStates = ["running", "finished", "failed", "lost", "stopped", "refused"] as const;
export type RunState = (typeof runStates)[number];
export const RunState = Type.Union(runStates.map((state) => Type.Literal(state)), {
  description:
    "`running` until its Agent finishes it (`finished`), its Runner reports it ended without finishing (`failed`), " +
    "nothing names it or its Ticket for the Workspace's lost-Run threshold (`lost`), or a User moves, undelegates or " +
    "re-delegates its Ticket (`stopped`). A Run its Runner wouldn't start is `refused`: its Ticket couldn't start.",
});

/** The states of a Run that went wrong: its Ticket waits in its Delegate's Owner's Inbox for Retry. */
export const wentWrongStates = ["failed", "lost", "refused"] as const satisfies readonly RunState[];
export type WentWrongState = (typeof wentWrongStates)[number];
export const WentWrongState = Type.Union(wentWrongStates.map((state) => Type.Literal(state)));
export const wentWrong = (state: RunState): state is WentWrongState => (wentWrongStates as readonly RunState[]).includes(state);
