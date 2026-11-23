import { Banner } from "./ui/controls.js";

/** The warning beside picking a Full token: when issuing one on an Agent's page, and when connecting an OAuth client. */
export function FullTokenWarning() {
  return (
    <Banner tone="warn" label="Full token">
      <p>
        A Full token may do what you may in the web client, within the same Access, such as moving and canceling
        Tickets. Only Accept and Reopen, Access and Admin settings, a Decision's status and resolving threads stay with
        Users. Give it only to a connection you work with yourself, never to a Run.
      </p>
    </Banner>
  );
}
