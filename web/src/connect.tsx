import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type ConnectRequest } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { FullTokenWarning } from "./full-token-warning.js";
import { Centered } from "./frame.js";
import { Actions, Button, FormError } from "./ui/controls.js";

/**
 * The consent screen of Cronk's OAuth server: a connector, such as claude.ai's, asks to
 * act in Cronk, and the signed-in User picks which of their Agents it acts as. Cronk opens it
 * as `/connect?request=<id>`, or `/connect?error=<code>` when it can't send the browser back.
 */

/** Why Cronk couldn't even ask, by the OAuth error code it sends the browser here with. */
const connectErrors: Record<string, string> = {
  invalid_client:
    "Cronk doesn't know the connector asking to connect, or couldn't read the metadata document it named. Start connecting again from where you began.",
  invalid_request: "The connector asked to send you back to an address it didn't register, so Cronk stopped here.",
};

export const connectErrorMessage = (code: string) =>
  connectErrors[code] ?? "The connector's request to connect didn't work. Start connecting again from where you began.";

export function ConnectScreen({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<ConnectRequest | { failed: string } | null>(null);
  useEffect(() => {
    api.connectRequest(requestId).then(setRequest, (error) =>
      setRequest({
        failed:
          error instanceof ApiError && error.status === 404
            ? "It has expired or was already answered. Start connecting again from where you began."
            : String(error instanceof Error ? error.message : error),
      }),
    );
  }, [requestId]);
  const [leaving, setLeaving] = useState(false);
  const leave = (url: string) => {
    setLeaving(true);
    window.location.assign(url);
  };
  const [access, setAccess] = useState<"write" | "full">("write");
  const approve = useSubmit(async (form) => {
    leave((await api.approveConnect(requestId, field(form, "agentId"), access)).redirectTo);
  });
  const deny = useSubmit(async () => {
    leave((await api.denyConnect(requestId)).redirectTo);
  });

  if (request === null) return <ConnectFrame title="Connect to Cronk">Loading…</ConnectFrame>;
  if ("failed" in request) {
    return (
      <ConnectFrame title="This request to connect doesn't work">
        <FormError error={request.failed} />
      </ConnectFrame>
    );
  }
  const name = request.client.name ?? "A connector";
  const returnHost = new URL(request.redirectUri).host;
  return (
    <ConnectFrame title={`Connect ${request.client.name ?? "a connector"} to Cronk`}>
      <p>
        <strong>{name}</strong> asks to act in Cronk as one of your Agents: to read its Workspace, and to do what that
        Agent may. Once you choose, you go back to <strong>{returnHost}</strong>.
      </p>
      {request.agents.length === 0 ? (
        <FormError error="You have no Agents yet. Create one on a Workspace's Agents page, then start connecting again." />
      ) : (
        <form id="connect-approve" onSubmit={approve.onSubmit}>
          <fieldset className="consent-agents">
            <legend className="field-label">Act as</legend>
            {request.agents.map((agent, index) => (
              <label key={agent.id} className="check">
                <input type="radio" name="agentId" value={agent.id} defaultChecked={index === 0} required />
                <span>
                  <span className="actor-agent-name">{agent.name}</span> <span className="muted">in {agent.workspace.name}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className="consent-agents">
            <legend className="field-label">Access</legend>
            <label className="check">
              <input type="radio" name="access" value="write" checked={access === "write"} onChange={() => setAccess("write")} />
              <span>
                Write <span className="muted">works under the Agent rules</span>
              </span>
            </label>
            <label className="check">
              <input type="radio" name="access" value="full" checked={access === "full"} onChange={() => setAccess("full")} />
              <span>
                Full <span className="muted">acts as you</span>
              </span>
            </label>
          </fieldset>
          {access === "full" && <FullTokenWarning />}
        </form>
      )}
      {/* Its button sits in the action row beside Connect, which belongs to the form above. */}
      <form id="connect-deny" hidden onSubmit={deny.onSubmit} />
      <FormError error={approve.error ?? deny.error} />
      <Actions>
        {request.agents.length > 0 && (
          <Button type="submit" form="connect-approve" variant="primary" disabled={approve.busy || leaving}>
            Connect
          </Button>
        )}
        <Button type="submit" form="connect-deny" disabled={deny.busy || leaving}>
          Don't connect
        </Button>
      </Actions>
      <p className="muted small">
        Removing the Agent, or revoking the token named {name} among its tokens, disconnects {name}.
      </p>
    </ConnectFrame>
  );
}

function ConnectFrame({ title, children }: { title: string; children: ReactNode }) {
  return <Centered title={title}>{children}</Centered>;
}

/** Why Cronk couldn't ask at all: shown without signing in, since there is nothing to approve. */
export function ConnectError({ code }: { code: string }) {
  return (
    <ConnectFrame title="This request to connect doesn't work">
      <FormError error={connectErrorMessage(code)} />
    </ConnectFrame>
  );
}
