import type { LabelRule, StepKind } from "./steps.js";

/**
 * The Steps of the default board every new Project starts with, by the name of the Status
 * each sits on. Outcomes name their target Status the same way. Their Briefs are only
 * defaults: each Project edits its own copy.
 */
export interface DefaultStep {
  kind?: StepKind;
  brief: string;
  model: string;
  labelRule?: LabelRule;
  outcomes: { name: string; status: string; default?: boolean; needsYou?: boolean; countsAsRound?: boolean }[];
}

const triage = `Triage this Ticket so the next Steps can work on it without asking.

- Read the Ticket, its Comments and its Relations.
- Make the description say what is wanted and how to tell it is done. Keep the author's words where they are clear.
- Set its Priority and Labels. Add \`no-review\` when the change is obvious and needs no code review, such as a docs-only fix.
- Split work that is clearly several pieces into Sub-Tickets.

Finish with **ready** when the Ticket is clear enough to investigate. Finish with **needs you** and a Question when only a User can say what is wanted.`;

const investigate = `Investigate how to do this Ticket's work, without changing any code yet.

- Read the Ticket, its Comments, its Relations and any earlier Reports.
- Find the code, documents and decisions the work touches, and anything that makes it risky.
- Write a Report on the Ticket: what you found, the approach you recommend and why, and the open questions, if any.

Finish with **done** once the Report gives the implementation what it needs. Finish with **needs you** and a Question when a choice only a User can make blocks the approach.`;

const implement = `Implement this Ticket's work.

- Read the Ticket, its Comments and the Reports of earlier Runs, the investigation's above all.
- Make the change on a branch named \`<type>/<KEY>-<slug>\`, with tests: \`<type>\` is \`feat\`, \`fix\`, \`docs\`, \`chore\` or \`refactor\`, \`<KEY>\` the Ticket's key and \`<slug>\` a few words of its title, such as \`fix/CRONK-12-lost-runs\`. Open a pull request whose title starts with the key.
- If the Ticket already has an open Pull Request, push to its branch instead of opening another.
- Leave a Comment on the Ticket linking the pull request and saying anything a reviewer should know.
- Don't wait for its checks: Cronk watches them, a failing check sends the Ticket back here, and the Merge Queue merges only once they are green. When the Ticket comes back for a failing check, read the failing job's log, fix it and push again.

Finish with **done** once the pull request is open with your change pushed. Finish with **needs you** and a Question when you can't go on without a User.`;

const codeReview = `Review the pull request this Ticket's implementation opened.

- Read the Ticket, its Comments and Reports, then the pull request's changes.
- Check that the change does what the Ticket asks, is tested, and follows the Repository's conventions.
- Write a Report with your findings, most serious first.

Finish with **approve** when it is ready for a User to merge. Finish with **changes** when it needs more work, saying what in your Report. Finish with **complete**, if you are offered it, when the work needs nothing more from a User. Finish with **needs you** and a Question when you can't judge it.`;

const merge = `Cronk merges this Ticket itself through the Merge Queue. This Run started because its Pull Request conflicts with its base branch, so it stepped aside in the queue; or, for a Ticket that joined on its own, because it had no Pull Request to queue.

- Read the Ticket, its Comments and Reports, and its Pull Requests. Its queue entry names the merge that caused the conflict.
- For a conflict: merge the base branch into the open Pull Request's branch and resolve the conflict, changing nothing beyond the conflicting hunks. Run what the resolution touches, then push to that branch. Never open another pull request, and never merge it yourself.
- With no Pull Request to queue: find out why, such as none was opened or linked, it is still a draft or closed, or it is in a Repository the Project doesn't list.

Finish with **resolved** once you've pushed the resolution: the Ticket waits in Merge for its checks, then rejoins the queue at the front. Finish with **send back** when the resolution isn't mechanical, such as when both sides changed the same logic, or when Implement can fix a missing, closed or draft Pull Request, first leaving a Comment saying why: it goes back to Implement. Finish with **needs you** and a Question when only a User can help.`;

export const defaultSteps: Record<string, DefaultStep> = {
  Triage: {
    brief: triage,
    model: "haiku",
    outcomes: [
      { name: "ready", status: "Ready", default: true },
      { name: "needs you", status: "Backlog", needsYou: true },
    ],
  },
  Investigate: {
    brief: investigate,
    model: "sonnet",
    outcomes: [
      { name: "done", status: "Implement", default: true },
      { name: "needs you", status: "Backlog", needsYou: true },
    ],
  },
  Implement: {
    brief: implement,
    model: "opus",
    outcomes: [
      { name: "done", status: "Code review", default: true },
      { name: "needs you", status: "Ready", needsYou: true },
    ],
  },
  "Code review": {
    brief: codeReview,
    model: "sonnet",
    labelRule: { kind: "skippedBy", label: "no-review" },
    outcomes: [
      { name: "approve", status: "Merge", default: true },
      { name: "changes", status: "Implement", countsAsRound: true },
      { name: "complete", status: "Done" },
      { name: "needs you", status: "In Review", needsYou: true },
    ],
  },
  // ADR 0005, ADR 0011: skipped, passing the Ticket on to In Review, unless an agent may merge it, when it joins the
  // Merge Queue instead, or a User queued it. Its Runs resolve a queued Ticket's conflicts: *resolved* leaves it in
  // Merge, and sending it back from such a Run counts as no round.
  Merge: {
    kind: "merge",
    brief: merge,
    model: "haiku",
    outcomes: [
      { name: "review", status: "In Review", default: true },
      { name: "resolved", status: "Merge" },
      { name: "send back", status: "Implement", countsAsRound: true },
      { name: "needs you", status: "In Review", needsYou: true },
    ],
  },
};
