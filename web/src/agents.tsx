import { useAddresses } from "./addresses.js";
import { AgentRecordPanel, useAgentRecord } from "./agent-record.js";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  nameOf,
  type Agent,
  type AgentToken,
  type TokenAccess,
  type Runner,
  type TicketSummary,
  type Transcript,
  type User,
  type WorkspaceSummary,
} from "./api.js";
import { field, useSubmit } from "./forms.js";
import { FullTokenWarning } from "./full-token-warning.js";
import { usePlace } from "./frame.js";
import { Link, navigate } from "./router.js";
import { Avatar } from "./ui/actor.js";
import { Button, EmptyState, Field, FormError, PageHead, Panel, RelativeTime, Saved, ShownOnce, workspaceCrumb } from "./ui/controls.js";
import { Key, RunState } from "./ui/labels.js";
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
  const to = useAddresses();
  const mine = agent.owner.id === user.id;
  const [renaming, setRenaming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const delegated = tickets.filter((t) => t.delegateId === agent.id);
  const running = delegated.filter((t) => t.lastRun?.state === "running");
  const page = to.agent(agent.id);
  return (
    <section className="panel agent-card" aria-label={agent.name}>
      <header className="agent-card-head">
        <Avatar actor={{ kind: "agent", name: agent.name }} size="medium" />
        <div>
          <h2 className="actor-agent-name">
            <Link to={page}>{agent.name}</Link>
          </h2>
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
      {running.length > 0 && (
        <ul className="agent-runs" aria-label="Running Runs">
          {running.map((ticket) => (
            <li key={ticket.id}>
              <Link to={to.ticket(ticket)}>
                <Key>{ticket.key}</Key> <span className="agent-run-title">{ticket.title}</span>
              </Link>
              <RunState state="running" />
            </li>
          ))}
        </ul>
      )}
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

/**
 * An Agent's page, any member's Agent, removed ones included: its Record. On the User's own Agent, its Runner, its
 * tokens behind Manage tokens and its Transcripts come first, with Rename and Remove in its "…" menu.
 */
export function AgentScreen({ user, workspace, agentId }: { user: User; workspace: WorkspaceSummary; agentId: string }) {
  const to = useAddresses();
  usePlace("agents");
  const recorded = useAgentRecord(agentId).data?.pages[0]?.agent;
  const [listed, setAgent] = useState<Agent | null>(null);
  // Only the Owner changes an Agent, and only while it is in use.
  const agent = listed && listed.owner.id === user.id ? listed : null;
  const name = listed?.name ?? recorded?.name;
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
          { label: "Agents", to: to.workspace("agents") },
        ]}
        title={
          <span className="actor actor-agent">
            {name && <Avatar actor={{ kind: "agent", name }} size="medium" />}
            <span className="actor-name">{name ?? "Agent"}</span>
            {recorded && recorded.owner.id !== user.id && <span className="muted small"> for {nameOf(recorded.owner)}</span>}
            {recorded?.removedAt && <span className="muted small"> removed</span>}
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
          {agent.runnerId === null && <p className="field-hint">Choose a Runner for its Runs to start.</p>}
        </Panel>
      )}
      {agent && (
        <Panel title="Tokens" id="tokens" description="An Agent connects with a token, such as from Claude Code on your laptop.">
          <AgentTokens agent={agent} />
        </Panel>
      )}
      {agent && <AgentTranscripts agent={agent} />}
      <AgentRecordPanel agentId={agentId} />
      {agent && renaming && <RenameAgent agent={agent} onClose={() => setRenaming(false)} onRenamed={setAgent} />}
      {agent && (
        <ConfirmDialog
          open={removing}
          onOpenChange={setRemoving}
          title={`Remove ${agent.name}?`}
          confirm="Remove"
          onConfirm={async () => {
            await api.removeAgent(agentId);
            navigate(to.workspace("agents"));
          }}
        >
          Its tokens stop working, and each Ticket delegated to it is undelegated, stopping its running Runs.
        </ConfirmDialog>
      )}
    </div>
  );
}

/**
 * The Agent's own Transcripts, of its sessions outside a Run such as Claude Code connected by hand, the last
 * uploaded first: each by its session, with the Tickets its Cronk tool calls named.
 */
function AgentTranscripts({ agent }: { agent: Agent }) {
  const to = useAddresses();
  const [transcripts, setTranscripts] = useState<Transcript[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.agentTranscripts(agent.id).then(setTranscripts, (e: Error) => setError(e.message));
  }, [agent.id]);
  return (
    <Panel
      title="Transcripts"
      id="transcripts"
      description="Its sessions outside a Run, such as Claude Code connected by hand, each shown on the Tickets it named."
    >
      <FormError error={error} />
      {transcripts === null ? (
        !error && <p className="muted small">Loading…</p>
      ) : transcripts.length === 0 ? (
        <p className="muted small">No Transcripts yet. A session's Transcript arrives with its Transcript hook's upload.</p>
      ) : (
        <ul className="agent-transcripts" aria-label="Transcripts">
          {transcripts.map((transcript) => (
            <li key={transcript.id}>
              <Link to={to.transcript(transcript)} className="mono agent-transcript-session">
                {transcript.sessionId}
              </Link>
              <span className="agent-transcript-tickets">
                {transcript.tickets.length === 0 ? (
                  <span className="muted small">No Tickets named</span>
                ) : (
                  transcript.tickets.map((ticket) => (
                    <Link key={ticket.id} to={to.ticket(ticket)} title={ticket.title}>
                      <Key>{ticket.key}</Key>
                    </Link>
                  ))
                )}
              </span>
              <span className="muted small">
                {transcript.entryCount} {transcript.entryCount === 1 ? "entry" : "entries"}, uploaded{" "}
                <RelativeTime at={transcript.uploadedAt} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** How a token's level reads in the web client. */
const tokenLevels: Record<TokenAccess, string> = { read: "Read", write: "Write", full: "Full" };

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
  const [revokingToken, setRevokingToken] = useState<AgentToken | null>(null);
  const [access, setAccess] = useState<TokenAccess>("write");
  const issue = useSubmit(async (form, element) => {
    setIssued(await api.issueToken(agent.id, { name: field(form, "name"), access }));
    element.reset();
    setAccess("write");
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
        <ShownOnce banner="Token issued" label={`Token ${issued.token.name}`} secret={issued.secret}>
          Connect Claude Code with{" "}
          <code>
            claude mcp add --transport http cronk {mcpUrl} --header "Authorization: Bearer {issued.secret}"
          </code>
        </ShownOnce>
      )}
      {tokens.length > 0 && (
        <table>
          <tbody>
            {tokens.map((token) => (
              <tr key={token.id}>
                <td>{token.name}</td>
                <td className="muted small">{tokenLevels[token.access]}</td>
                <td className="muted small">
                  <RelativeTime at={token.createdAt} />
                </td>
                <td className="cell-actions">
                  <div>
                    <Button variant="ghost" size="small" onClick={() => setRevokingToken(token)}>
                      Revoke
                    </Button>
                  </div>
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
            <select name="access" value={access} onChange={(event) => setAccess(event.target.value as TokenAccess)}>
              <option value="read">Read: only reads</option>
              <option value="write">Write: works under the Agent rules</option>
              <option value="full">Full: acts as you</option>
            </select>
          </Field>
          <Button type="submit" variant="primary" disabled={issue.busy}>
            Issue token
          </Button>
        </div>
        {access === "full" && <FullTokenWarning />}
        <FormError error={issue.error} />
      </form>
      <DialogActions>
        <DialogClose asChild>
          <Button>Close</Button>
        </DialogClose>
      </DialogActions>
      <ConfirmDialog
        open={revokingToken !== null}
        onOpenChange={(open) => !open && setRevokingToken(null)}
        title={`Revoke ${revokingToken?.name ?? "token"}?`}
        confirm="Revoke"
        onConfirm={async () => {
          if (!revokingToken) return;
          await api.revokeToken(agent.id, revokingToken.id);
          if (issued?.token.id === revokingToken.id) setIssued(null);
          onChanged();
        }}
      >
        Whatever connects with it stops working until it is given a new token.
      </ConfirmDialog>
    </Dialog>
  );
}
