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
  /** Whether its Runs may not change files; off unless set. */
  readOnly?: boolean;
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
- Find the code, documents and decisions the work touches, and anything that makes it risky: this Ticket's Project's documents and decisions, and another Project's only where the Ticket names it.
- If the work needs something not on the default branch yet that is a change of its own, such as a harness or a shared helper, split it off now: \`create_sub_ticket\` for it, saying what it must provide and for which Ticket. This Ticket gets no Runs until its Sub-Tickets are finished, so Implement starts once the prerequisite is done. For a prerequisite in another Project, \`file_ticket\` there and \`add_block\` from it to this Ticket.
- Write a Report on the Ticket: what you found, the approach you recommend and why, any prerequisite you split off, and the open questions, if any.

Finish with **done** once the Report gives the implementation what it needs. Finish with **needs you** and a Question when a choice only a User can make blocks the approach.`;

const implement = `Implement this Ticket's work.

- Read the Ticket, its Comments and the Reports of earlier Runs, the investigation's above all.
- Make the change on a branch named \`<type>/<KEY>-<slug>\`, with tests: \`<type>\` is \`feat\`, \`fix\`, \`docs\`, \`chore\` or \`refactor\`, \`<KEY>\` the Ticket's key and \`<slug>\` a few words of its title, such as \`fix/CRONK-12-lost-runs\`. Open a pull request whose title starts with the key.
- If the Ticket already has an open Pull Request, push to its branch instead of opening another.
- One pull request per Ticket: never open a second one, or one that waits on another. If the work needs something not on the default branch yet, include it in this pull request when it is small. Otherwise \`create_sub_ticket\` for it, saying what it must provide and for which Ticket (or, in another Project, \`file_ticket\` there and \`add_block\` from it to this Ticket), commit nothing for it here, and finish with **needs you**, naming that Ticket in the Question.
- Leave a Comment on the Ticket linking the pull request and saying anything a reviewer should know.
- Don't wait for its checks: Cronk watches them, a failing check sends the Ticket back here, and the Merge Queue merges only once they are green. When the Ticket comes back for a failing check, read the failing job's log, fix it and push again.

Finish with **done** once the pull request is open with your change pushed. Finish with **needs you** and a Question when you can't go on without a User.`;

const codeReview = `Review the pull request this Ticket's implementation opened.

- Read the Ticket, its Comments and Reports, then the pull request's changes.
- Check that the change does what the Ticket asks, is tested, and follows the Repository's conventions.
- Write a Report with your findings, most serious first.

Finish with **approve** when it is ready for a User to merge. Finish with **changes** when it needs more work, saying what in your Report. Finish with **complete**, if you are offered it, when the work needs nothing more from a User. Finish with **needs you** and a Question when you can't judge it.`;

const merge = `Cronk merges this Ticket itself through the Merge Queue. This Run started because its Pull Request conflicts with its base branch, so it stepped aside in the queue; because it merged after its Release was cut, so it needs a backport onto the release branch, as the start of this Brief then says; or, for a Ticket that joined on its own, because it had no Pull Request to queue.

- Read the Ticket, its Comments and Reports, and its Pull Requests. Its queue entry names the merge that caused the conflict.
- For a conflict: merge the base branch into the open Pull Request's branch and resolve the conflict, changing nothing beyond the conflicting hunks. Run what the resolution touches, then push to that branch. Never open another pull request, and never merge it yourself.
- For a backport: cherry-pick the merge commit onto a branch named \`backport/<KEY>-<name>\` off \`release/<name>\`, where \`<name>\` is the Release's, changing nothing beyond what the cherry-pick needs. Run what it touches, push the branch and open a pull request against \`release/<name>\` whose title starts with the key. Never merge it yourself.
- With no Pull Request to queue: find out why, such as none was opened or linked, it is still a draft or closed, or it is in a Repository the Project doesn't list.

Finish with **resolved** once you've pushed the resolution: the Ticket waits in Merge for its checks, then rejoins the queue at the front. Finish with **backported** once the backport pull request is open: it joins the release branch's Merge Queue. Finish with **send back** when the resolution isn't mechanical, such as when both sides changed the same logic, when the cherry-pick isn't either, or when Implement can fix a missing, closed or draft Pull Request, first leaving a Comment saying why: it goes back to Implement. Finish with **needs you** and a Question when only a User can help.`;

export const defaultSteps: Record<string, DefaultStep> = {
  Triage: {
    brief: triage,
    model: "haiku",
    readOnly: true,
    outcomes: [
      { name: "ready", status: "Ready", default: true },
      { name: "needs you", status: "Backlog", needsYou: true },
    ],
  },
  Investigate: {
    brief: investigate,
    model: "sonnet",
    readOnly: true,
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
  // Merge Queue instead, or a User queued it. Its Runs resolve a queued Ticket's conflicts, and backport a merge onto
  // its Release's release branch: *resolved* and *backported* leave it in Merge, and sending it back from such a Run
  // counts as no round.
  Merge: {
    kind: "merge",
    brief: merge,
    model: "haiku",
    outcomes: [
      { name: "review", status: "In Review", default: true },
      { name: "resolved", status: "Merge" },
      { name: "backported", status: "Merge" },
      { name: "send back", status: "Implement", countsAsRound: true },
      { name: "needs you", status: "In Review", needsYou: true },
    ],
  },
};
