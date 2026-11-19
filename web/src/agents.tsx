import { useCallback, useEffect, useState } from "react";
import { api, nameOf, type Agent, type AgentToken, type Runner, type TicketSummary, type User, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { Link, navigate } from "./router.js";
import { Avatar } from "./ui/actor.js";
import { Banner, Button, EmptyState, Field, FormError, PageHead, Panel, RelativeTime, Saved, workspaceCrumb } from "./ui/controls.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose, Menu, MenuItem } from "./ui/overlays.js";

/** Every Ticket of the Workspace, to count what each Agent is delegated and running. */
function useWorkspaceTickets(workspaceId: string): TicketSummary[] {
  const [tickets, setTickets] = useState<TicketSummary[]>([]);
  useEffect(() => {
    api
      .projects(workspaceId)
      .then((projects) => Promise.all(projects.map((p) => api.tickets(p.id))))
      .then((lists) => setTickets(lists.flat()), () => setTickets([]));
  }, [workspaceId]);
  return tickets;
}

/** The Workspace's Agents: everyone's are listed, and a User changes only their own. */
export function Agents({ user, workspace }: { user: User; workspace: WorkspaceSummary }) {
  usePlace("agents");
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const tickets = useWorkspaceTickets(workspace.id);
  const refresh = useCallback(() => {
    api.agents(workspace.id).then(setAgents, (e: Error) => setError(e.message));
  }, [workspace.id]);
  useEffect(refresh, [refresh]);

  const create = useSubmit(async (form) => {
    await api.createAgent(workspace.id, field(form, "name"));
    setCreating(false);
    refresh();
  });

  return (
    <div className="page">
      <PageHead
        crumbs={[workspaceCrumb(workspace)]}
        title="Agents"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New Agent
          </Button>
        }
      />
      <p className="muted">An Agent acts in Cronk for its Owner, such as Claude Code on your laptop, spending its Owner's credentials.</p>
      <FormError error={error} />
      {agents === null ? (
        <p className="muted">Loading…</p>
      ) : agents.length === 0 ? (
        <EmptyState title="No Agents yet.">New Agent creates one; give it a token to connect with, and a Runner to start its Runs.</EmptyState>
      ) : (
        <div className="cards">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} user={user} workspace={workspace} tickets={tickets} onChanged={refresh} />
          ))}
        </div>
      )}
      <Dialog open={creating} onOpenChange={setCreating} title="New Agent" description="It acts in Cronk for you.">
        <form onSubmit={create.onSubmit}>
          <Field label="Agent name">
            <input name="name" required autoComplete="off" placeholder="claude-max" className="mono" autoFocus />
          </Field>
          <FormError error={create.error} />
          <DialogActions>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={create.busy}>
              Create Agent
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </div>
  );
}

function AgentCard({
  agent,
  user,
  workspace,
  tickets,
  onChanged,
}: {
  agent: Agent;
  user: User;
  workspace: WorkspaceSummary;
  tickets: TicketSummary[];
  onChanged: () => void;
}) {
  const mine = agent.owner.id === user.id;
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const delegated = tickets.filter((t) => t.delegateId === agent.id);
  const running = delegated.filter((t) => t.lastRun?.state === "running");
  const page = `/workspaces/${workspace.id}/agents/${agent.id}`;
  return (
    <section className="panel agent-card" aria-label={agent.name}>
      <header className="agent-card-head">
        <Avatar actor={{ kind: "agent", name: agent.name }} size="medium" />
        <div>
          <h2 className="actor-agent-name">{mine ? <Link to={page}>{agent.name}</Link> : agent.name}</h2>
          <p className="muted small">{mine ? "Yours" : `for ${nameOf(agent.owner)}`}</p>
        </div>
        {mine && (
          <div className="actions">
            <Menu label={`More for ${agent.name}`}>
              <MenuItem onSelect={() => setRenaming(true)}>Rename…</MenuItem>
              <MenuItem tone="danger" onSelect={() => setRemoving(true)}>
                Remove…
              </MenuItem>
            </Menu>
          </div>
        )}
      </header>
      <div className="stats">
        <span className="stat">
          <strong>{delegated.length}</strong> <span className="muted">delegated</span>
        </span>
        <span className="stat">
          <strong>{running.length}</strong> <span className="muted">running</span>
        </span>
      </div>
      {mine && <AgentTokens agent={agent} />}
      {renaming && <RenameAgent agent={agent} onClose={() => setRenaming(false)} onRenamed={onChanged} />}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${agent.name}?`}
        confirm="Remove"
        onConfirm={async () => {
          await api.removeAgent(agent.id);
          onChanged();
        }}
      >
        Its tokens stop working, and each Ticket delegated to it is undelegated, stopping its running Runs.
      </ConfirmDialog>
    </section>
  );
}

function RenameAgent({ agent, onClose, onRenamed }: { agent: Agent; onClose: () => void; onRenamed: (agent: Agent) => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    onRenamed(await api.renameAgent(agent.id, field(form, "name")));
    onClose();
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`Rename ${agent.name}`}>
      <form onSubmit={onSubmit}>
        <Field label="Agent name">
          <input name="name" required defaultValue={agent.name} className="mono" autoFocus />
        </Field>
        <FormError error={error} />
        <DialogActions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={busy}>
            Rename
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** One of the User's own Agents: its Runner, and its tokens behind Manage tokens; Rename and Remove in its "…" menu. */
export function AgentScreen({ workspace, agentId }: { workspace: WorkspaceSummary; agentId: string }) {
  usePlace("agents");
  const [agent, setAgent] = useState<Agent | null>(null);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const refresh = useCallback(() => {
    api.agents(workspace.id).then(
      (agents) => setAgent(agents.find((a) => a.id === agentId) ?? null),
      (e: Error) => setError(e.message),
    );
    api.runners().then(setRunners, (e: Error) => setError(e.message));
  }, [workspace.id, agentId]);
  useEffect(refresh, [refresh]);

  const setRunner = async (runnerId: string | null) => {
    setError(null);
    try {
      setAgent(await api.setAgentRunner(agentId, runnerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page page-settings">
      <PageHead
        crumbs={[
          workspaceCrumb(workspace),
          { label: "Agents", to: `/workspaces/${workspace.id}/agents` },
        ]}
        title={
          <span className="actor actor-agent">
            {agent && <Avatar actor={{ kind: "agent", name: agent.name }} size="medium" />}
            <span className="actor-name">{agent?.name ?? "Agent"}</span>
          </span>
        }
        actions={
          agent && (
            <Menu label={`More for ${agent.name}`}>
              <MenuItem onSelect={() => setRenaming(true)}>Rename…</MenuItem>
              <MenuItem tone="danger" onSelect={() => setRemoving(true)}>
                Remove…
              </MenuItem>
            </Menu>
          )
        }
      />
      <FormError error={error} />
      {agent && (
        <Panel>
          <p className="muted small">How Cronk starts this Agent's Runs, spending your credentials.</p>
          <Field label="Runner" hint={<Link to="/runners">Set up your Runners</Link>}>
            <select value={agent.runnerId ?? ""} onChange={(event) => void setRunner(event.target.value || null)}>
              <option value="">None: its Runs can't start</option>
              {runners.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </Field>
        </Panel>
      )}
      {agent && (
        <Panel title="Tokens" id="tokens" description="An Agent connects with a token, such as from Claude Code on your laptop.">
          <AgentTokens agent={agent} />
        </Panel>
      )}
      {agent && renaming && <RenameAgent agent={agent} onClose={() => setRenaming(false)} onRenamed={setAgent} />}
      {agent && (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${agent.name}?`}
          confirm="Remove"
          onConfirm={async () => {
            await api.removeAgent(agentId);
            navigate(`/workspaces/${workspace.id}/agents`);
          }}
        >
          Its tokens stop working, and each Ticket delegated to it is undelegated, stopping its running Runs.
        </ConfirmDialog>
      )}
    </div>
  );
}

/** An Agent's tokens in one line, with Manage tokens opening the dialog that issues and revokes them. */
function AgentTokens({ agent }: { agent: Agent }) {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const refresh = useCallback(() => {
    api.tokens(agent.id).then(
      (list) => {
        setTokens(list);
        setError(null);
      },
      (e: Error) => setError(e.message),
    );
  }, [agent.id]);
  useEffect(refresh, [refresh]);
  return (
    <div className="agent-tokens">
      <span className="small">
        {tokens === null
          ? "Tokens…"
          : tokens.length === 0
            ? "No tokens"
            : `${tokens.length} token${tokens.length === 1 ? "" : "s"}: ${tokens.map((t) => t.name).join(", ")}`}
      </span>
      <Button variant="ghost" size="small" onClick={() => setManaging(true)}>
        Manage tokens
      </Button>
      <FormError error={error} />
      {managing && (
        <ManageTokens agent={agent} tokens={tokens ?? []} onChanged={refresh} onClose={() => setManaging(false)} />
      )}
    </div>
  );
}

/**
 * Issues and revokes an Agent's tokens. A new token's secret shows once, with Copy, until the dialog closes;
 * revoking asks first, since the Agent's connection breaks until a new token is pasted in.
 */
function ManageTokens({
  agent,
  tokens,
  onChanged,
  onClose,
}: {
  agent: Agent;
  tokens: AgentToken[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [issued, setIssued] = useState<{ token: AgentToken; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<AgentToken | null>(null);
  const issue = useSubmit(async (form, element) => {
    const access = field(form, "access") === "read" ? "read" : "full";
    setIssued(await api.issueToken(agent.id, { name: field(form, "name"), access }));
    element.reset();
    onChanged();
  });
  const mcpUrl = `${window.location.origin}/mcp`;
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Tokens of ${agent.name}`}
      description="An Agent connects with a token, such as from Claude Code on your laptop."
    >
      {issued && (
        <Banner tone="warn" label="Token issued">
          <Field label={`Token ${issued.token.name}`}>
            <div className="copy-row">
              <input readOnly value={issued.secret} className="mono" onFocus={(event) => event.currentTarget.select()} />
              <CopyButton text={issued.secret} />
            </div>
          </Field>
          <p>
            Copy it now: it is shown only once. Connect Claude Code with{" "}
            <code>
              claude mcp add --transport http cronk {mcpUrl} --header "Authorization: Bearer {issued.secret}"
            </code>
          </p>
        </Banner>
      )}
      {tokens.length > 0 && (
        <table className="tokens">
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td className="muted small">{token.access === "read" ? "Read-only" : "Full"}</td>
                <td className="muted small">
                  <RelativeTime at={token.createdAt} />
                </td>
                <td className="cell-actions">
                  <Button variant="ghost" size="small" onClick={() => setRevoking(token)}>
                    Revoke
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={issue.onSubmit} aria-label="Issue a token">
        <div className="form-row">
          <Field label="Token name">
            <input name="name" required autoComplete="off" placeholder="laptop" />
          </Field>
          <Field label="Access">
            <select name="access" defaultValue="full">
              <option value="full">Full: read and comment</option>
              <option value="read">Read-only</option>
            </select>
          </Field>
          <Button type="submit" variant="primary" disabled={issue.busy}>
            Issue token
          </Button>
        </div>
        <FormError error={issue.error} />
      </form>
      <DialogActions>
        <DialogClose asChild>
          <Button>Close</Button>
        </DialogClose>
      </DialogActions>
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "token"}?`}
        confirm="Revoke"
        onConfirm={async () => {
          if (!revoking) return;
          await api.revokeToken(agent.id, revoking.id);
          if (issued?.token.id === revoking.id) setIssued(null);
          onChanged();
        }}
      >
        Whatever connects with it stops working until it is given a new token.
      </ConfirmDialog>
    </Dialog>
  );
}

/** Copies a secret to the clipboard and says so. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = () => {
    setCopied(false);
    setError(null);
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setError("Couldn't copy: select it and copy it yourself."),
    );
  };
  return (
    <>
      <Button onClick={copy}>Copy</Button>
      <Saved shown={copied}>Copied.</Saved>
      <FormError error={error} />
    </>
  );
}
