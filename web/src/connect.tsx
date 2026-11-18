import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type ConnectRequest } from "./api.js";
import { field, useSubmit } from "./forms.js";

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
  const approve = useSubmit(async (form) => {
    leave((await api.approveConnect(requestId, field(form, "agentId"))).redirectTo);
  });
  const deny = useSubmit(async () => {
    leave((await api.denyConnect(requestId)).redirectTo);
  });

  if (request === null) return <ConnectFrame title="Connect to Cronk">Loading…</ConnectFrame>;
  if ("failed" in request) {
    return (
      <ConnectFrame title="This request to connect doesn't work">
        <p role="alert">{request.failed}</p>
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
        <p role="alert">You have no Agents yet. Create one on a Workspace's Agents page, then start connecting again.</p>
      ) : (
        <form onSubmit={approve.onSubmit}>
          <fieldset>
            <legend>Act as</legend>
            {request.agents.map((agent, index) => (
              <label key={agent.id} className="check">
                <input type="radio" name="agentId" value={agent.id} defaultChecked={index === 0} required />
                {agent.name} <span className="muted">in {agent.workspace.name}</span>
              </label>
            ))}
          </fieldset>
          {approve.error && <p role="alert">{approve.error}</p>}
          <button type="submit" disabled={approve.busy || leaving}>
            Connect
          </button>
        </form>
      )}
      <form onSubmit={deny.onSubmit}>
        {deny.error && <p role="alert">{deny.error}</p>}
        <button type="submit" className="secondary" disabled={deny.busy || leaving}>
          Don't connect
        </button>
      </form>
      <p className="muted">
        Removing the Agent, or revoking the token named {name} among its tokens, disconnects {name}.
      </p>
    </ConnectFrame>
  );
}

function ConnectFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="centered">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

/** Why Cronk couldn't ask at all: shown without signing in, since there is nothing to approve. */
export function ConnectError({ code }: { code: string }) {
  return (
    <ConnectFrame title="This request to connect doesn't work">
      <p role="alert">{connectErrorMessage(code)}</p>
    </ConnectFrame>
  );
}
