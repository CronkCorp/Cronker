import { useEffect, useState } from "react";
import { api, type Inbox, type InboxItem, type RunItem, type Workspace } from "./api.js";
import { useLatest, useLiveEvents } from "./live.js";
import { Markdown } from "./markdown.js";
import { Link } from "./router.js";

/**
 * The User's Inbox in the Workspace, fetched again after each live event: an Inbox is worked
 * out from current state, so any change in the Workspace may add or remove an item.
 */
function useInbox(workspaceId: string): { inbox: Inbox | null; failure: string | null } {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const load = () =>
    latest(
      api.inbox(workspaceId),
      (loaded) => {
        setInbox(loaded);
        setFailure(null);
      },
      (e) => setFailure(e.message),
    );
  useEffect(load, [workspaceId, latest]);
  useLiveEvents(workspaceId, load);
  return { inbox, failure };
}

/** The Inbox link for the navigation, with its count. */
export function InboxLink({ workspaceId, current }: { workspaceId: string; current: boolean }) {
  const count = useInbox(workspaceId).inbox?.count ?? null;
  const waiting = count === null ? "" : count === 0 ? ", nothing waiting" : `, ${count} waiting`;
  return (
    <Link to={`/workspaces/${workspaceId}/inbox`} current={current} aria-label={`Inbox${waiting}`}>
      Inbox{count ? <span className="count">{count}</span> : null}
    </Link>
  );
}

/** Everything in the Workspace waiting on the signed-in User. */
export function InboxScreen({ workspace }: { workspace: Workspace }) {
  const { inbox, failure } = useInbox(workspace.id);
  return (
    <section>
      <h1>Inbox</h1>
      {failure && <p role="alert">{failure}</p>}
      {inbox &&
        (inbox.items.length === 0 ? (
          <p>Nothing is waiting on you.</p>
        ) : (
          <ul className="inbox" aria-label="Inbox">
            {inbox.items.map((item) => (
              <Item key={`${item.kind} ${item.kind === "question" ? item.question.id : item.ticket.id}`} item={item} />
            ))}
          </ul>
        ))}
    </section>
  );
}

function Item({ item }: { item: InboxItem }) {
  return (
    <li>
      <Link to={`/tickets/${item.ticket.id}`}>
        <span className="muted">{item.ticket.key}</span> {item.ticket.title}
      </Link>
      <ItemDetail item={item} />
    </li>
  );
}

const wentWrong = { failed: "failed", lost: "was lost", refused: "couldn't start" } as const;

/** A Run that went wrong, and Retry, which starts a fresh Run of the same Step. */
function WentWrong({ item }: { item: RunItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retry = () => {
    setBusy(true);
    setError(null);
    // The Inbox reloads on the live event the Retry causes, which takes this item away.
    api.retry(item.ticket.id).then(
      () => setBusy(false),
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  return (
    <>
      <small>
        Its {item.run.step.name} Run <span className={`run-state ${item.run.state}`}>{wentWrong[item.run.state]}</span>
        {item.run.endReason && <>: {item.run.endReason}</>}
      </small>
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={retry} disabled={busy} aria-label={`Retry ${item.ticket.key}`}>
        Retry
      </button>
    </>
  );
}

/** What an Inbox item waits on the User for. */
function ItemDetail({ item }: { item: InboxItem }) {
  const [failure, setFailure] = useState<string | null>(null);
  switch (item.kind) {
    case "question":
      return (
        <>
          <small>
            {item.question.agent.name} asks, from the {item.question.step.name} Step; reply to the Question on the Ticket to answer
          </small>
          <blockquote className="question">
            <Markdown text={item.question.body} mentions={[]} />
          </blockquote>
          <div>
            <button
              type="button"
              className="link"
              onClick={() => api.dismissQuestion(item.question.id).catch((e: Error) => setFailure(e.message))}
            >
              Dismiss
            </button>
          </div>
          {failure && <p role="alert">{failure}</p>}
        </>
      );
    case "needsYou":
      return (
        <small>
          Handed back to you in {item.status.name}: the {item.step.name} Step finished with {item.outcome}
        </small>
      );
    case "review":
      return <small>Waiting for your review in {item.status.name}</small>;
    case "unverified":
      return (
        <small>Completed by the {item.completedBy?.name ?? "removed"} Step, Unverified: Accept or Reopen it</small>
      );
    case "run":
      return <WentWrong item={item} />;
  }
}
