import { useState } from "react";
import { api, type Check, type PullRequest } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { Button, ExternalLink, FormError, RelativeTime } from "./ui/controls.js";
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
 * The Pull Requests linked to the Ticket, by its key in their branch or title or by hand, one row each: number, title,
 * state and check counts, review state, the failing check that last sent the Ticket back, and a conflict with its base
 * branch; those linked by hand say
 * so. GitHub's webhooks keep them current. Given the Ticket (`linking`), the section always shows, with Unlink on those
 * linked by hand and a form to link another by its address; otherwise it is hidden until there is one.
 */
export function PullRequestRows({
  pullRequests,
  linking,
}: {
  pullRequests: PullRequest[];
  linking?: { ticketId: string; onChanged: () => void };
}) {
  const [unlinkError, setUnlinkError] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  if (pullRequests.length === 0 && !linking) return null;
  const unlink = async (pullRequestId: number) => {
    if (!linking || unlinking) return;
    setUnlinking(true);
    setUnlinkError(null);
    try {
      await api.unlinkPullRequest(linking.ticketId, pullRequestId);
      linking.onChanged();
    } catch (e) {
      setUnlinkError(e instanceof Error ? e.message : String(e));
    } finally {
      setUnlinking(false);
    }
  };
  return (
    <section aria-label="Pull Requests" className="panel side-section">
      <h2 className="side-title">Pull Requests</h2>
      {pullRequests.length > 0 && (
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
                {pr.manual && <span className="small muted">Linked by hand</span>}
                {pr.manual && linking && (
                  <Button variant="ghost" size="small" disabled={unlinking} onClick={() => void unlink(pr.id)} aria-label={`Unlink #${pr.number}`}>
                    Unlink
                  </Button>
                )}
              </span>
              {pr.sentBack?.kind === "check" && <SentBackBy sentBack={pr.sentBack} />}
              {pr.conflict && <ConflictMarker conflict={pr.conflict} />}
            </li>
          ))}
        </ul>
      )}
      <FormError error={unlinkError} />
      {linking && <LinkPullRequest {...linking} />}
    </section>
  );
}

/** Links a Pull Request whose branch or title doesn't name the Ticket's key, by its address or `owner/name#number`. */
function LinkPullRequest({ ticketId, onChanged }: { ticketId: string; onChanged: () => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form, element) => {
    await api.linkPullRequest(ticketId, field(form, "pullRequest"));
    element.reset();
    onChanged();
  });
  return (
    <form onSubmit={onSubmit} className="side-form">
      <div className="side-form-row">
        <input
          name="pullRequest"
          required
          placeholder="Pull Request address, or owner/name#12"
          aria-label="Pull Request to link"
          className="mono"
        />
      </div>
      <div>
        <Button type="submit" size="small" disabled={busy}>
          Link Pull Request
        </Button>
      </div>
      <FormError error={error} />
    </form>
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

/** *Conflicts with `<base>`*, linking the merge that made it conflict when Cronk knows it. */
function ConflictMarker({ conflict }: { conflict: NonNullable<PullRequest["conflict"]> }) {
  const what = (
    <>
      <span className="check-failed" aria-hidden="true">
        ✗
      </span>{" "}
      Conflicts with <span className="mono">{conflict.branch}</span>
    </>
  );
  return (
    <span className="small muted pr-conflict">
      {conflict.merge ? (
        <ExternalLink url={conflict.merge.url}>
          {what} since {conflict.merge.repository}#{conflict.merge.number}
        </ExternalLink>
      ) : (
        what
      )}{" "}
      <RelativeTime at={conflict.at} />
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

/**
 * For a Ticket in a Review Status: a card per Pull Request with its branch, state, review state, a conflict with its
 * base branch and every check.
 */
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
          {pr.conflict && (
            <p>
              <ConflictMarker conflict={pr.conflict} />
            </p>
          )}
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
