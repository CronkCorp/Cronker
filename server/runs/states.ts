import { Type } from "typebox";

/** Where a Run stands. Kept apart from `runs.ts` so Tickets can name it without importing Runs. */
export const runStates = ["running", "finished", "failed", "refused"] as const;
export type RunState = (typeof runStates)[number];
export const RunState = Type.Union(runStates.map((state) => Type.Literal(state)), {
  description:
    "`running` until its Agent finishes it (`finished`), its Runner reports it ended without finishing (`failed`), " +
    "or its Runner refused to start it (`refused`).",
});
