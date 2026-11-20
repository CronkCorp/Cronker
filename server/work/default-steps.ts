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
- Make the change on a branch named after the Ticket's key, with tests, and open a pull request whose title starts with the key.
- If the Ticket already has an open Pull Request, push to its branch instead of opening another.
- Leave a Comment on the Ticket linking the pull request and saying anything a reviewer should know.

Finish with **done** once the pull request is open and its checks pass. Finish with **needs you** and a Question when you can't go on without a User.`;

const codeReview = `Review the pull request this Ticket's implementation opened.

- Read the Ticket, its Comments and Reports, then the pull request's changes.
- Check that the change does what the Ticket asks, is tested, and follows the Repository's conventions.
- Write a Report with your findings, most serious first.

Finish with **approve** when it is ready for a User to merge. Finish with **changes** when it needs more work, saying what in your Report. Finish with **complete**, if you are offered it, when the work needs nothing more from a User. Finish with **needs you** and a Question when you can't judge it.`;

const merge = `Check whether the pull request this Ticket's implementation opened is ready to merge.

- Read the Ticket, its Comments and Reports, and its Pull Request's state, checks and reviews.
- Never resolve a merge conflict or change code yourself: that is Implement's work.

Finish with **review** when it is ready, for a User to merge. Finish with **send back** when it has a merge conflict or a failing check, saying which in a Comment. Finish with **needs you** and a Question when you can't tell.`;

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
  // ADR 0005: skipped, passing the Ticket on to In Review, unless an agent may merge it.
  Merge: {
    kind: "merge",
    brief: merge,
    model: "haiku",
    outcomes: [
      { name: "review", status: "In Review", default: true },
      { name: "send back", status: "Implement", countsAsRound: true },
      { name: "needs you", status: "In Review", needsYou: true },
    ],
  },
};
