import { useEffect, useState } from "react";
import { api, type Inbox, type Workspace } from "./api.js";
import { useLatest, useLiveEvents } from "./live.js";
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
              <li key={`${item.kind} ${item.ticket.id}`}>
                <Link to={`/tickets/${item.ticket.id}`}>
                  <span className="muted">{item.ticket.key}</span> {item.ticket.title}
                </Link>
                <small>Waiting for your review in {item.status.name}</small>
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}
