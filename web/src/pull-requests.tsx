import { type Check, type PullRequest } from "./api.js";
import { ExternalLink, RelativeTime } from "./ui/controls.js";
import { Key, PullRequestState } from "./ui/labels.js";

const marks: { state: Check["state"]; mark: string }[] = [
  { state: "passed", mark: "✓" },
  { state: "failed", mark: "✗" },
  { state: "pending", mark: "●" },
];

/** How many of a Pull Request's checks passed, failed and are still running, each count naming its checks. */
export function CheckCounts({ checks }: { checks: Check[] }) {
  const counts = marks
    .map((m) => ({ ...m, checks: checks.filter((c) => c.state === m.state) }))
    .filter((c) => c.checks.length > 0);
  if (counts.length === 0) return null;
  return (
    <span className="checks">
      {counts.map((c) => {
        const names = c.checks.map((check) => check.name).join(", ");
        return (
          <span key={c.state} className={`check-${c.state}`} title={names} aria-label={`${c.checks.length} ${c.state}: ${names}`}>
            {c.mark} {c.checks.length}
          </span>
        );
      })}
    </span>
  );
}

/**
 * The Pull Requests whose branch or title names the Ticket's key, one row each: number, title, state and check
 * counts, review state, and the failing check that last sent the Ticket back. Hidden until there is one; GitHub's webhooks keep them current.
 */
export function PullRequestRows({ pullRequests }: { pullRequests: PullRequest[] }) {
  if (pullRequests.length === 0) return null;
  return (
    <section aria-label="Pull Requests" className="panel side-section">
      <h2 className="side-title">Pull Requests</h2>
      <ul className="side-list pr-rows">
        {pullRequests.map((pr) => (
          <li key={pr.id}>
            <a href={pr.url} target="_blank" rel="noreferrer">
              <Key>#{pr.number}</Key> {pr.title}
            </a>
            <span className="pr-meta">
              <PullRequestState state={pr.state} />
              <CheckCounts checks={pr.checks} />
              <ReviewState pullRequest={pr} />
            </span>
            {pr.sentBack?.kind === "check" && <SentBackBy sentBack={pr.sentBack} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Where a Pull Request's review stands: who merged it, or else who approved it or requested changes, linking the review. */
function ReviewState({ pullRequest: pr }: { pullRequest: PullRequest }) {
  if (pr.mergedBy) return <span className="small muted">Merged by @{pr.mergedBy}</span>;
  if (!pr.reviewState) return null;
  const { state, reviewer, url } = pr.reviewState;
  const what = `${state === "approved" ? "Approved" : "Changes requested"} by @${reviewer}`;
  return (
    <span className="small">
      <ExternalLink url={url}>{what}</ExternalLink>
    </span>
  );
}

/** A failing check that last sent the Ticket back to its producing Step from a Pull Request. */
function SentBackBy({ sentBack }: { sentBack: Extract<NonNullable<PullRequest["sentBack"]>, { kind: "check" }> }) {
  const what = (
    <>
      <span className="check-failed" aria-hidden="true">
        ✗
      </span>{" "}
      {sentBack.name} failed
    </>
  );
  return (
    <span className="small muted">
      Sent back:{" "}
      <ExternalLink url={sentBack.url}>{what}</ExternalLink>{" "}
      <RelativeTime at={sentBack.at} />
    </span>
  );
}

/** Each check's mark and the word for its state, failing first: what waits on the User comes first. */
const checkStates = {
  failed: { mark: "✗", word: "failed", order: 0 },
  pending: { mark: "●", word: "running", order: 1 },
  passed: { mark: "✓", word: "passed", order: 2 },
  neutral: { mark: "–", word: "neutral", order: 3 },
} as const;

/** For a Ticket in a Review Status: a card per Pull Request with its branch, state, review state and every check. */
export function PullRequestCards({ pullRequests }: { pullRequests: PullRequest[] }) {
  if (pullRequests.length === 0) return null;
  return (
    <section aria-label="Code to review" className="pr-cards">
      <h2>Code to review</h2>
      {pullRequests.map((pr) => (
        <article key={pr.id} className="panel pr-card" aria-label={`#${pr.number} ${pr.title}`}>
          <header className="pr-card-head">
            <a href={pr.url} target="_blank" rel="noreferrer">
              <Key>
                {pr.repository}#{pr.number}
              </Key>{" "}
              {pr.title}
            </a>
            <PullRequestState state={pr.state} />
          </header>
          <p className="small muted">
            <span className="mono">{pr.branch}</span>
            {pr.producingStep && <> · from the {pr.producingStep.name} Step</>}
            {(pr.mergedBy || pr.reviewState) && (
              <>
                {" · "}
                <ReviewState pullRequest={pr} />
              </>
            )}
          </p>
          {pr.checks.length > 0 && (
            <ul className="pr-checks">
              {[...pr.checks]
                .sort((a, b) => checkStates[a.state].order - checkStates[b.state].order)
                .map((check) => (
                  <li key={check.name} className="pr-check">
                    <span className={`check-${check.state}`} aria-hidden="true">
                      {checkStates[check.state].mark}
                    </span>{" "}
                    <ExternalLink url={check.url}>{check.name}</ExternalLink>{" "}
                    <span className="pr-check-state">{checkStates[check.state].word}</span>
                  </li>
                ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
