import type { RunnerRefusal, RunReports, Runner, RunToStart, StartResult } from "../../server/runs/runner.js";

/**
 * The fake Runner every `startCronk()` installs as the Runner kind `fake`. It records each
 * start, and the test can tell it to refuse the next starts or report a Run ended without finishing.
 */
export class FakeRunner implements Runner {
  /** Every start asked of it, refused or not, in order. */
  readonly starts: RunToStart[] = [];
  private readonly refusals: RunnerRefusal[] = [];
  private reports?: RunReports;

  /** The Runner kind to give Cronk. */
  readonly kind = (reports: RunReports): Runner => {
    this.reports = reports;
    return this;
  };

  async start(run: RunToStart): Promise<StartResult> {
    this.starts.push(run);
    const refusal = this.refusals.shift();
    if (refusal) return { started: false, refusal };
    return {
      started: true,
      reference: { sessionId: `session_${this.starts.length}`, url: `https://claude.ai/code/session_${this.starts.length}` },
    };
  }

  /** Refuses the next start with this refusal. */
  refuseNext(refusal: RunnerRefusal): void {
    this.refusals.push(refusal);
  }

  /** Reports that the Run's session ended without the agent calling `finish`. */
  async endWithoutFinishing(runId: string, reason = "The session ended."): Promise<void> {
    if (!this.reports) throw new Error("the fake Runner wasn't given to Cronk");
    await this.reports.endedWithoutFinishing(runId, reason);
  }
}
