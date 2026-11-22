import { useEffect, useState } from "react";
import { useAddresses } from "./addresses.js";
import { api, type MovedOnDependent } from "./api.js";
import { Link } from "./router.js";
import { RunState, StatusPill } from "./ui/labels.js";

/**
 * In a Reopen dialog, the Tickets the reopened one blocks that moved on since it was completed, each with its Status
 * and whether a Run is running: Cronk tells each of them, quoting the reason. Fetched when the dialog opens; with none,
 * or until they load, nothing shows.
 */
export function MovedOnDependents({ ticketId, open }: { ticketId: string; open: boolean }) {
  const to = useAddresses();
  const [dependents, setDependents] = useState<MovedOnDependent[]>([]);
  useEffect(() => {
    if (!open) return;
    let current = true;
    void api.reopenPreview(ticketId).then(
      (preview) => current && setDependents(preview.dependents),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [ticketId, open]);
  if (dependents.length === 0) return null;
  return (
    <div className="moved-on">
      <p id={`moved-on-${ticketId}`} className="small">
        {dependents.length === 1 ? "A Ticket it blocks has" : `${dependents.length} Tickets it blocks have`} moved on since it
        was completed. Cronk tells {dependents.length === 1 ? "it" : "each"}, quoting your Comment.
      </p>
      <ul aria-labelledby={`moved-on-${ticketId}`} className="side-list">
        {dependents.map(({ ticket, status, running }) => (
          <li key={ticket.id} className="moved-on-row">
            <Link to={to.ticket(ticket)} className="ticket-link">
              <span className="ticket-key">{ticket.key}</span> {ticket.title}
            </Link>
            <StatusPill kind={status.kind} name={status.name} />
            {running && <RunState state="running" />}
          </li>
        ))}
      </ul>
    </div>
  );
}
