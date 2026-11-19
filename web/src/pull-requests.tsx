import { type Check, type PullRequest } from "./api.js";
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
 * counts. Hidden until there is one; GitHub's webhooks keep them current.
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
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const checkWords = { passed: "✓", failed: "✗", pending: "●", neutral: "–" } as const;

/** For a Ticket in a Review Status: a card per Pull Request with its branch, state and every check. */
export function PullRequestCards({ pullRequests }: { pullRequests: PullRequest[] }) {
  if (pullRequests.length === 0) return null;
  return (
    <section aria-label="Code to review" className="pr-cards">
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
          </p>
          {pr.checks.length > 0 && (
            <ul className="side-list">
              {pr.checks.map((check) => (
                <li key={check.name} className="pr-check">
                  <span className={`check-${check.state}`} aria-hidden="true">
                    {checkWords[check.state]}
                  </span>{" "}
                  {check.url ? (
                    <a href={check.url} target="_blank" rel="noreferrer">
                      {check.name}
                    </a>
                  ) : (
                    check.name
                  )}
                  <span className="sr-only"> {check.state}</span>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
