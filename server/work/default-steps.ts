/**
 * The Steps of the default board every new Project starts with, by the name of the Status
 * each sits on. Outcomes name their target Status the same way. Their Briefs are only
 * defaults: each Project edits its own copy.
 */
export interface DefaultStep {
  brief: string;
  model: string;
  outcomes: { name: string; status: string; default?: boolean; needsYou?: boolean; countsAsRound?: boolean }[];
}

const triage = `Triage this Ticket so the next Steps can work on it without asking.

- Read the Ticket, its Comments and its Relations.
- Make the description say what is wanted and how to tell it is done. Keep the author's words where they are clear.
- Set its Priority and Labels. Add \`no-review\` when the change is obvious and needs no code review, such as a docs-only fix.
- Split work that is clearly several pieces into Sub-Tickets.

Finish with **ready** when the Ticket is clear enough to investigate. Finish with **needs you** and a Question when only a person can say what is wanted.`;

const investigate = `Investigate how to do this Ticket's work, without changing any code yet.

- Read the Ticket, its Comments, its Relations and any earlier Reports.
- Find the code, documents and decisions the work touches, and anything that makes it risky.
- Write a Report on the Ticket: what you found, the approach you recommend and why, and the open questions, if any.

Finish with **done** once the Report gives the implementation what it needs. Finish with **needs you** and a Question when a choice only a person can make blocks the approach.`;

const implement = `Implement this Ticket's work.

- Read the Ticket, its Comments and the Reports of earlier Runs, the investigation's above all.
- Make the change on a branch named after the Ticket's key, with tests, and open a pull request whose title starts with the key.
- Leave a Comment on the Ticket linking the pull request and saying anything a reviewer should know.

Finish with **done** once the pull request is open and its checks pass. Finish with **needs you** and a Question when you can't go on without a person.`;

const codeReview = `Review the pull request this Ticket's implementation opened.

- Read the Ticket, its Comments and Reports, then the pull request's changes.
- Check that the change does what the Ticket asks, is tested, and follows the Repository's conventions.
- Write a Report with your findings, most serious first.

Finish with **approve** when it is ready for a person to merge. Finish with **changes** when it needs more work, saying what in your Report. Finish with **complete**, if you are offered it, when the work needs nothing more from a person. Finish with **needs you** and a Question when you can't judge it.`;

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
    outcomes: [
      { name: "approve", status: "In Review", default: true },
      { name: "changes", status: "Implement", countsAsRound: true },
      { name: "complete", status: "Done" },
      { name: "needs you", status: "In Review", needsYou: true },
    ],
  },
};
