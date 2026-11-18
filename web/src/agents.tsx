import { useCallback, useEffect, useState } from "react";
import { api, type Agent, type AgentToken, type Runner, type User, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { Link, navigate } from "./router.js";

/** The Workspace's Agents: everyone's are listed, and a User changes only their own. */
export function Agents({ user, workspace }: { user: User; workspace: WorkspaceSummary }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.agents(workspace.id).then(setAgents, (e: Error) => setError(e.message));
  }, [workspace.id]);
  useEffect(refresh, [refresh]);

  const create = useSubmit(async (form, element) => {
    await api.createAgent(workspace.id, field(form, "name"));
    element.reset();
    refresh();
  });

  return (
    <section>
      <h1>{workspace.name}: Agents</h1>
      <p>
        An Agent acts in Cronk for its Owner, such as Claude Code on your laptop. Give it a token to connect with.
      </p>
      <div className="admin-forms">
        <form onSubmit={create.onSubmit}>
          <label>
            Agent name
            <input name="name" required autoComplete="off" placeholder="claude-max" />
          </label>
          {create.error && <p role="alert">{create.error}</p>}
          <button type="submit" disabled={create.busy}>
            Create Agent
          </button>
        </form>
      </div>
      {error && <p role="alert">{error}</p>}
      {agents === null ? (
        <p>Loading…</p>
      ) : agents.length === 0 ? (
        <p>No Agents yet.</p>
      ) : (
        <table>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.id}>
                <td>
                  {agent.owner.id === user.id ? (
                    <Link to={`/workspaces/${workspace.id}/agents/${agent.id}`}>{agent.name}</Link>
                  ) : (
                    agent.name
                  )}
                </td>
                <td>{agent.owner.id === user.id ? "yours" : `of ${agent.owner.email ?? `@${agent.owner.githubLogin}`}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** One of the User's own Agents: rename or remove it, and issue and revoke its tokens. */
export function AgentScreen({ workspace, agentId }: { workspace: WorkspaceSummary; agentId: string }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [issued, setIssued] = useState<{ token: AgentToken; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.agents(workspace.id).then(
      (agents) => setAgent(agents.find((a) => a.id === agentId) ?? null),
      (e: Error) => setError(e.message),
    );
    api.tokens(agentId).then(setTokens, (e: Error) => setError(e.message));
    api.runners().then(setRunners, (e: Error) => setError(e.message));
  }, [workspace.id, agentId]);
  useEffect(refresh, [refresh]);

  const rename = useSubmit(async (form) => {
    setAgent(await api.renameAgent(agentId, field(form, "name")));
  });
  const issue = useSubmit(async (form, element) => {
    const access = field(form, "access") === "read" ? "read" : "full";
    setIssued(await api.issueToken(agentId, { name: field(form, "name"), access }));
    element.reset();
    refresh();
  });
  const act = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const mcpUrl = `${window.location.origin}/mcp`;

  return (
    <section>
      <p>
        <Link to={`/workspaces/${workspace.id}/agents`}>All Agents</Link>
      </p>
      <h1>{agent?.name ?? "Agent"}</h1>
      {error && <p role="alert">{error}</p>}
      {agent && (
        <div className="admin-forms">
          <form onSubmit={rename.onSubmit}>
            <label>
              Agent name
              <input name="name" required defaultValue={agent.name} />
            </label>
            {rename.error && <p role="alert">{rename.error}</p>}
            <button type="submit" disabled={rename.busy}>
              Rename
            </button>
          </form>
          <label>
            Runner
            <select
              value={agent.runnerId ?? ""}
              onChange={(event) => {
                const runnerId = event.target.value || null;
                void act(async () => setAgent(await api.setAgentRunner(agentId, runnerId)));
              }}
            >
              <option value="">None: its Runs can't start</option>
              {runners.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <small>
              <Link to="/runners">Set up your Runners</Link>
            </small>
          </label>
          <form onSubmit={issue.onSubmit}>
            <label>
              Token name
              <input name="name" required autoComplete="off" placeholder="laptop" />
            </label>
            <label>
              Access
              <select name="access" defaultValue="full">
                <option value="full">Full: read and comment</option>
                <option value="read">Read-only</option>
              </select>
            </label>
            {issue.error && <p role="alert">{issue.error}</p>}
            <button type="submit" disabled={issue.busy}>
              Issue token
            </button>
          </form>
        </div>
      )}
      {issued && (
        <div className="issued-link">
          <label>
            Token {issued.token.name}
            <input readOnly value={issued.secret} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <small>
            Copy it now: it is shown only once. Connect Claude Code with{" "}
            <code>
              claude mcp add --transport http cronk {mcpUrl} --header "Authorization: Bearer {issued.secret}"
            </code>
          </small>
        </div>
      )}
      {tokens && tokens.length > 0 && (
        <table>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td>{token.access === "read" ? "Read-only" : "Full"}</td>
                <td>{new Date(token.createdAt).toLocaleDateString()}</td>
                <td className="actions">
                  <button
                    type="button"
                    onClick={() =>
                      act(async () => {
                        await api.revokeToken(agentId, token.id);
                        if (issued?.token.id === token.id) setIssued(null);
                        refresh();
                      })
                    }
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {agent && (
        <p>
          <button
            type="button"
            onClick={() =>
              act(async () => {
                await api.removeAgent(agentId);
                navigate(`/workspaces/${workspace.id}/agents`);
              })
            }
          >
            Remove Agent
          </button>
        </p>
      )}
    </section>
  );
}
