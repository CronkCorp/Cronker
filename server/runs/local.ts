import type { Runner, StartResult } from "./runner.js";

/**
 * The local Runner: Runs run on a Machine of its Owner's, through Claude Code's CLI signed in with their own
 * subscription. Cronk can't reach a Machine, so the Runner is pulled rather than pushed (ADR 0014): starting a Run
 * reaches no Machine, and answers *started* with no session reference yet, leaving the Run for a Machine serving the
 * Runner to claim.
 */
export function localRunner(): Runner {
  return {
    // Its Runs run on the Owner's own Machine, so `local-only` Tickets go to it.
    cloud: false,
    async start(): Promise<StartResult> {
      return { started: true, reference: {} };
    },
    // A removed Runner's Runs stop, so nothing keeps running on a Machine unseen.
    stopsRunsWhenRemoved: true,
  };
}
