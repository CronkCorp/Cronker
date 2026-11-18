import { useEffect, useState } from "react";
import { api, type Inbox, type Workspace } from "./api.js";
import { Link } from "./router.js";

/** What the Workspace's event stream says of the User's Inbox. */
export interface InboxSignal {
  /** The Inbox count, once the stream has sent it. */
  count: number | null;
  /** Goes up each time the Inbox changes, so a page showing it knows to fetch it again. */
  version: number;
}

/** Follows the User's Inbox in the Workspace over its event stream. */
export function useInboxSignal(workspaceId: string | undefined): InboxSignal {
  const [signal, setSignal] = useState<InboxSignal>({ count: null, version: 0 });
  useEffect(() => {
    setSignal({ count: null, version: 0 });
    if (!workspaceId) return;
    const source = new EventSource(api.eventsUrl(workspaceId));
    source.addEventListener("inbox", (event) => {
      const { count } = JSON.parse((event as MessageEvent<string>).data) as { count: number };
      setSignal((last) => ({ count, version: last.version + 1 }));
    });
    return () => source.close();
  }, [workspaceId]);
  return signal;
}

/** The Inbox link for the navigation, with its count. */
export function InboxLink({ workspaceId, count, current }: { workspaceId: string; count: number | null; current: boolean }) {
  const waiting = count === null ? "" : count === 0 ? ", nothing waiting" : `, ${count} waiting`;
  return (
    <Link to={`/workspaces/${workspaceId}/inbox`} current={current} aria-label={`Inbox${waiting}`}>
      Inbox{count ? <span className="count">{count}</span> : null}
    </Link>
  );
}

/** Everything in the Workspace waiting on the signed-in User. */
export function InboxScreen({ workspace, version }: { workspace: Workspace; version: number }) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api.inbox(workspace.id).then(
      (loaded) => {
        setInbox(loaded);
        setFailure(null);
      },
      (e: Error) => setFailure(e.message),
    );
  }, [workspace.id, version]);

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
