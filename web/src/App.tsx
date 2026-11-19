import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  api,
  ApiError,
  type Link as LinkInfo,
  type LinkDetails,
  type Member,
  nameOf,
  type PendingAdd,
  type User,
  type WorkspaceSettings,
  type WorkspaceSummary,
} from "./api.js";
import { AgentScreen, Agents } from "./agents.js";
import { field, useSubmit } from "./forms.js";
import { ConnectError, ConnectScreen } from "./connect.js";
import { Centered, Frame, usePlace } from "./frame.js";
import { GitHubPage, GitHubSetupStep, GitHubSignIn, githubErrorMessage, takeQueryParameter } from "./github.js";
import { DecisionScreen, WorkspaceDecisions } from "./decisions.js";
import { DocumentScreen, WorkspaceDocuments } from "./documents.js";
import { TermScreen, WorkspaceGlossary } from "./terms.js";
import { InboxScreen } from "./inbox.js";
import { ProjectScreen, WorkspaceHome } from "./projects.js";
import { navigate, replace, usePath } from "./router.js";
import { RunnersScreen } from "./runners.js";
import { takeReturnAfterSignIn } from "./storage.js";
import { TicketScreen } from "./tickets.js";
import { Avatar } from "./ui/actor.js";
import { Actions, Button, EmptyState, Field, FormError, PageHead, Panel, Saved, workspaceCrumb } from "./ui/controls.js";
import { ConfirmDialog, Menu, MenuItem } from "./ui/overlays.js";

type Screen =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "connectGitHub" }
  | { kind: "signIn"; notice?: string }
  | { kind: "signedIn"; user: User; workspaces: WorkspaceSummary[] };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [failure, setFailure] = useState<string | null>(null);
  // Cronk sends the browser back here with `github_error` when signing in with GitHub failed.
  const [githubNotice] = useState(() => {
    const code = takeQueryParameter("github_error");
    return code ? githubErrorMessage(code) : undefined;
  });
  const path = usePath();
  // Links Cronk hands out open `/link`, with their secret in the fragment.
  const onLinkPage = path === "/link";
  // A connector asking to connect opens `/connect`, the consent screen of Cronk's OAuth server.
  const connect = path === "/connect" ? new URLSearchParams(window.location.search) : null;

  const load = useCallback(async (notice?: string) => {
    try {
      if (await api.setupNeeded()) return setScreen({ kind: "setup" });
      const me = await api.me();
      // Signing in with GitHub on the way somewhere, such as the consent screen, ends at `/`; carry on there.
      const returnTo = takeReturnAfterSignIn();
      if (returnTo && /^\/(?!\/)/.test(returnTo) && window.location.pathname === "/") replace(returnTo);
      setScreen({ kind: "signedIn", user: me.user, workspaces: me.workspaces });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        return setScreen({ kind: "signIn", notice: notice ?? githubNotice });
      }
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, [githubNotice]);

  useEffect(() => {
    if (!onLinkPage) void load();
  }, [load, onLinkPage]);

  if (failure) {
    return (
      <Centered title="Cronk can't be reached">
        <p role="alert" className="form-error">
          {failure}
        </p>
        <Button
          variant="primary"
          onClick={() => {
            setFailure(null);
            setScreen({ kind: "loading" });
            void load();
          }}
        >
          Try again
        </Button>
      </Centered>
    );
  }
  if (onLinkPage) {
    return (
      <LinkScreen
        onDone={(notice) => {
          setScreen({ kind: "loading" });
          replace("/");
          void load(notice);
        }}
      />
    );
  }
  const connectError = connect?.get("error");
  if (connectError) return <ConnectError code={connectError} />;
  switch (screen.kind) {
    case "loading":
      return <Centered title="Cronk">Loading…</Centered>;
    case "setup":
      return <SetupScreen onDone={() => setScreen({ kind: "connectGitHub" })} />;
    case "connectGitHub":
      return <GitHubSetupStep onSkip={() => load()} />;
    case "signIn":
      return (
        <SignInScreen
          notice={connect ? "Sign in to Cronk to choose which of your Agents the connector acts as." : screen.notice}
          returnTo={connect ? `${window.location.pathname}${window.location.search}` : undefined}
          onSignedIn={() => load()}
        />
      );
    case "signedIn":
      if (connect) return <ConnectScreen requestId={connect.get("request") ?? ""} />;
      return (
        <SignedIn
          user={screen.user}
          workspaces={screen.workspaces}
          path={path}
          reload={() => load()}
          onSignedOut={() => setScreen({ kind: "signIn", notice: "You're signed out." })}
        />
      );
  }
}

function SetupScreen({ onDone }: { onDone: () => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const email = field(form, "email");
    const password = field(form, "password");
    await api.setUp({
      setupCode: field(form, "setupCode"),
      email,
      password,
      workspaceName: field(form, "workspaceName"),
    });
    // Signed in, the first User can go on to create the GitHub App.
    await api.signIn(email, password);
    onDone();
  });
  return (
    <Centered title="Set up Cronk">
      <p className="muted">Enter the setup code from Cronk's log, then create the first User and their Workspace.</p>
      <form onSubmit={onSubmit}>
        <Field label="Setup code">
          <input name="setupCode" required autoComplete="off" className="mono" />
        </Field>
        <Field label="Email">
          <input name="email" type="email" required autoComplete="username" />
        </Field>
        <Field label="Password">
          <input name="password" type="password" required minLength={8} autoComplete="new-password" />
        </Field>
        <Field label="Workspace name">
          <input name="workspaceName" required />
        </Field>
        <FormError error={error} />
        <Button type="submit" variant="primary" className="button-wide" disabled={busy}>
          Set up
        </Button>
      </form>
    </Centered>
  );
}

function SignInScreen({ notice, returnTo, onSignedIn }: { notice?: string; returnTo?: string; onSignedIn: () => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api.signIn(field(form, "email"), field(form, "password"));
    onSignedIn();
  });
  return (
    <Centered title="Sign in to Cronk">
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <form onSubmit={onSubmit}>
        <Field label="Email">
          <input name="email" type="email" required autoComplete="username" />
        </Field>
        <Field label="Password">
          <input name="password" type="password" required autoComplete="current-password" />
        </Field>
        <FormError error={error} />
        <Button type="submit" variant="primary" className="button-wide" disabled={busy}>
          Sign in
        </Button>
      </form>
      <GitHubSignIn returnTo={returnTo} />
    </Centered>
  );
}

/** A one-time link: joining a Workspace or setting a new password. */
function LinkScreen({ onDone }: { onDone: (notice: string) => void }) {
  const token = window.location.hash.slice(1);
  const [details, setDetails] = useState<LinkDetails | null | "invalid">(null);
  useEffect(() => {
    api.lookUpLink(token).then(setDetails, () => setDetails("invalid"));
  }, [token]);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    if (details === null || details === "invalid") return;
    await api.useLink(token, field(form, "password"));
    onDone(
      details.kind === "join"
        ? `You've joined ${details.workspace?.name}. Sign in to continue.`
        : "Your password is set. Sign in with it.",
    );
  });

  if (details === null) return <Centered title="Cronk">Loading…</Centered>;
  if (details === "invalid") {
    return (
      <Centered title="This link doesn't work">
        <p className="muted">It has been used, has expired or never existed. Ask an Admin of your Workspace for a new one.</p>
      </Centered>
    );
  }
  const joining = details.kind === "join";
  if (details.signInWithGitHub) {
    return (
      <Centered title={`Join ${details.workspace?.name}`}>
        <p>
          You're joining as <strong>{details.email}</strong>, who signs in with GitHub. Signing in with GitHub joins you.
        </p>
        <GitHubSignIn />
      </Centered>
    );
  }
  return (
    <Centered title={joining ? `Join ${details.workspace?.name}` : "Set a new password"}>
      <p>
        {joining ? "You're joining as " : "For "}
        <strong>{details.email ?? "your GitHub account"}</strong>.
      </p>
      <form onSubmit={onSubmit}>
        <input type="hidden" name="username" value={details.email ?? ""} autoComplete="username" />
        {details.setsPassword ? (
          <Field label="Choose a password">
            <input name="password" type="password" required minLength={8} autoComplete="new-password" />
          </Field>
        ) : (
          <Field label="Your password">
            <input name="password" type="password" required autoComplete="current-password" />
          </Field>
        )}
        <FormError error={error} />
        <Button type="submit" variant="primary" className="button-wide" disabled={busy}>
          {joining ? "Join" : "Set password"}
        </Button>
      </form>
    </Centered>
  );
}

function SignedIn({
  user,
  workspaces,
  path,
  reload,
  onSignedOut,
}: {
  user: User;
  workspaces: WorkspaceSummary[];
  path: string;
  reload: () => void;
  onSignedOut: () => void;
}) {
  const workspacePath = /^\/workspaces\/([^/]+)(?:\/(members|settings|agents|inbox|documents|glossary|decisions)(?:\/([^/]+))?)?\/?$/.exec(path);
  const projectPath = /^\/projects\/([^/]+)(?:\/(list|settings|documents|glossary|decisions))?\/?$/.exec(path);
  const ticketPath = /^\/tickets\/([^/]+)\/?$/.exec(path);
  const documentPath = /^\/documents\/([^/]+)\/?$/.exec(path);
  const termPath = /^\/terms\/([^/]+)\/?$/.exec(path);
  const decisionPath = /^\/decisions\/([^/]+)\/?$/.exec(path);
  const routedId = workspacePath && workspacePath[1] !== "new" ? decodeURIComponent(workspacePath[1]!) : null;

  // The Workspace on screen: the one in the path, else the last one shown (pages such as a
  // Project's carry none in their path), else the first.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (routedId) setSelectedId(routedId);
  }, [routedId]);
  const current = routedId
    ? workspaces.find((w) => w.id === routedId)
    : (workspaces.find((w) => w.id === selectedId) ?? workspaces[0]);

  useEffect(() => {
    if (path === "/" && workspaces[0]) replace(`/workspaces/${workspaces[0].id}`);
  }, [path, workspaces]);

  const onOtherWorkspace = (workspaceId: string) => {
    if (!workspaces.some((w) => w.id === workspaceId)) return false;
    setSelectedId(workspaceId);
    return true;
  };

  let page: ReactNode;
  if (path === "/workspaces/new") {
    page = (
      <NewWorkspace
        onCreated={(created) => {
          navigate(`/workspaces/${created.id}`);
          reload();
        }}
      />
    );
  } else if (path === "/password") {
    page = <ChangePassword />;
  } else if (path === "/github") {
    page = <GitHubPage workspaces={workspaces} />;
  } else if (path === "/runners") {
    page = <RunnersScreen workspaces={workspaces} />;
  } else if (current && projectPath) {
    page = (
      <ProjectScreen
        key={`${current.id} ${projectPath[1]}`}
        workspace={current}
        projectId={projectPath[1]!}
        view={(projectPath[2] as "list" | "settings" | "documents" | "glossary" | "decisions" | undefined) ?? "board"}
        onOtherWorkspace={onOtherWorkspace}
      />
    );
  } else if (current && ticketPath) {
    page = (
      <TicketScreen
        key={`${current.id} ${ticketPath[1]}`}
        workspace={current}
        user={user}
        ticketId={ticketPath[1]!}
        onOtherWorkspace={onOtherWorkspace}
      />
    );
  } else if (current && documentPath) {
    page = (
      <DocumentScreen
        key={`${current.id} ${documentPath[1]}`}
        workspace={current}
        documentId={documentPath[1]!}
        onOtherWorkspace={onOtherWorkspace}
      />
    );
  } else if (current && termPath) {
    page = (
      <TermScreen key={`${current.id} ${termPath[1]}`} workspace={current} termId={termPath[1]!} onOtherWorkspace={onOtherWorkspace} />
    );
  } else if (current && decisionPath) {
    page = (
      <DecisionScreen
        key={`${current.id} ${decisionPath[1]}`}
        workspace={current}
        decisionId={decisionPath[1]!}
        onOtherWorkspace={onOtherWorkspace}
      />
    );
  } else if (current && workspacePath?.[2] === "glossary" && !workspacePath[3]) {
    page = <WorkspaceGlossary key={current.id} workspace={current} />;
  } else if (current && workspacePath?.[2] === "decisions" && !workspacePath[3]) {
    page = <WorkspaceDecisions key={current.id} workspace={current} />;
  } else if (current && workspacePath?.[2] === "documents" && !workspacePath[3]) {
    page = <WorkspaceDocuments key={current.id} workspace={current} />;
  } else if (current && workspacePath?.[2] === "inbox" && !workspacePath[3]) {
    page = <InboxScreen key={current.id} workspace={current} user={user} />;
  } else if (current && workspacePath?.[2] === "agents" && workspacePath[3]) {
    page = <AgentScreen key={`${current.id} ${workspacePath[3]}`} workspace={current} agentId={workspacePath[3]} />;
  } else if (current && workspacePath?.[2] === "agents") {
    page = <Agents key={current.id} user={user} workspace={current} />;
  } else if (current && workspacePath?.[2] === "settings" && !workspacePath[3]) {
    page = <WorkspaceSettingsPage key={current.id} workspace={current} onChanged={reload} />;
  } else if (current && workspacePath?.[2] === "members" && !workspacePath[3]) {
    page = (
      <Members
        key={current.id}
        user={user}
        workspace={current}
        onChanged={reload}
        onLeft={() => {
          navigate("/");
          reload();
        }}
      />
    );
  } else if (current && (routedId || path === "/")) {
    page = <WorkspaceHome key={current.id} workspace={current} />;
  } else if (workspaces.length === 0 && path === "/") {
    page = <PlacelessEmptyState title="You don't belong to any Workspace yet.">Create one from the Workspace menu, or ask an Admin to add you.</PlacelessEmptyState>;
  } else {
    page = <PlacelessEmptyState title="Nothing is here.">The page may have moved, or you may not see it.</PlacelessEmptyState>;
  }

  return (
    <Frame
      user={user}
      workspaces={workspaces}
      current={current}
      onSignOut={async () => {
        await api.signOut();
        onSignedOut();
      }}
    >
      {page}
    </Frame>
  );
}

/** An empty page that belongs to no sidebar item, such as one that isn't there; the sidebar marks none. */
function PlacelessEmptyState({ title, children }: { title: string; children: ReactNode }) {
  usePlace(null);
  return <EmptyState title={title}>{children}</EmptyState>;
}

function NewWorkspace({ onCreated }: { onCreated: (workspace: WorkspaceSummary) => void }) {
  usePlace(null);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    onCreated(await api.createWorkspace(field(form, "name")));
  });
  return (
    <div className="page page-settings">
      <PageHead crumbs={[{ label: "Workspaces" }]} title="New Workspace" />
      <Panel>
        <p className="muted">You'll be its Admin, and can add Users to it.</p>
        <form onSubmit={onSubmit}>
          <Field label="Workspace name">
            <input name="name" required />
          </Field>
          <FormError error={error} />
          <Actions>
            <Button type="submit" variant="primary" disabled={busy}>
              Create Workspace
            </Button>
          </Actions>
        </form>
      </Panel>
    </div>
  );
}

function ChangePassword() {
  usePlace(null);
  const [done, setDone] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async (form, element) => {
    setDone(false);
    await api.changePassword(field(form, "currentPassword"), field(form, "newPassword"));
    element.reset();
    setDone(true);
  });
  return (
    <div className="page page-settings">
      <PageHead crumbs={[{ label: "Account" }]} title="Password" />
      <Panel>
        <form onSubmit={onSubmit}>
          <Field label="Current password">
            <input name="currentPassword" type="password" required autoComplete="current-password" />
          </Field>
          <Field label="New password" hint="At least 8 characters. Changing it ends your other sign-ins.">
            <input name="newPassword" type="password" required minLength={8} autoComplete="new-password" />
          </Field>
          <FormError error={error} />
          <Actions>
            <Button type="submit" variant="primary" disabled={busy}>
              Change password
            </Button>
            <Saved shown={done}>Password changed. Your other sign-ins have ended.</Saved>
          </Actions>
        </form>
      </Panel>
    </div>
  );
}

function IssuedLink({ label, link }: { label: string; link: LinkInfo }) {
  return (
    <div className="issued">
      <Field label={label} hint={`Pass it on yourself. It works once, until ${new Date(link.expiresAt).toLocaleString()}.`}>
        <input readOnly value={link.url} className="mono" onFocus={(event) => event.currentTarget.select()} />
      </Field>
    </div>
  );
}

/** The Workspace's name and its settings, for Admins. */
function WorkspaceSettingsPage({ workspace, onChanged }: { workspace: WorkspaceSummary; onChanged: () => void }) {
  usePlace("settings");
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [renamed, setRenamed] = useState(false);
  const [savedThreshold, setSavedThreshold] = useState(false);
  useEffect(() => {
    api.workspaceSettings(workspace.id).then(setSettings, (e: Error) => setFailure(e.message));
  }, [workspace.id]);
  const rename = useSubmit(async (form) => {
    setRenamed(false);
    await api.renameWorkspace(workspace.id, field(form, "name"));
    setRenamed(true);
    onChanged();
  });
  const changeSettings = useSubmit(async (form) => {
    setSavedThreshold(false);
    setSettings(await api.changeWorkspaceSettings(workspace.id, { lostRunMinutes: Number(field(form, "lostRunMinutes")) }));
    setSavedThreshold(true);
  });
  return (
    <div className="page page-settings">
      <PageHead crumbs={[workspaceCrumb(workspace)]} title="Settings" />
      <FormError error={failure} />
      <Panel title="Name" id="workspace-name">
        <form onSubmit={rename.onSubmit}>
          <Field label="Workspace name">
            <input name="name" required defaultValue={workspace.name} />
          </Field>
          <FormError error={rename.error} />
          <Actions>
            <Button type="submit" variant="primary" disabled={rename.busy}>
              Rename
            </Button>
            <Saved shown={renamed} />
          </Actions>
        </form>
      </Panel>
      {settings && (
        <Panel title="Lost Runs" id="lost-runs" description="A Run nothing has named for this long is lost, and waits in its Assignee's Inbox for Retry.">
          <form onSubmit={changeSettings.onSubmit}>
            <Field label="Lost-Run threshold (minutes)">
              <input name="lostRunMinutes" type="number" min={1} max={10080} required defaultValue={settings.lostRunMinutes} />
            </Field>
            <FormError error={changeSettings.error} />
            <Actions>
              <Button type="submit" variant="primary" disabled={changeSettings.busy}>
                Save threshold
              </Button>
              <Saved shown={savedThreshold} />
            </Actions>
          </form>
        </Panel>
      )}
    </div>
  );
}

function Members({
  user,
  workspace,
  onChanged,
  onLeft,
}: {
  user: User;
  workspace: WorkspaceSummary;
  onChanged: () => void;
  onLeft: () => void;
}) {
  usePlace("members");
  const [members, setMembers] = useState<Member[] | null>(null);
  const [pending, setPending] = useState<PendingAdd[]>([]);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const refresh = useCallback(() => {
    api.members(workspace.id).then(setMembers, (e: Error) => setError(e.message));
    if (workspace.isAdmin) api.pendingAdds(workspace.id).then(setPending, (e: Error) => setError(e.message));
    else setPending([]);
  }, [workspace.id, workspace.isAdmin]);
  useEffect(refresh, [refresh]);

  const act = async (action: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = useSubmit(async (form, element) => {
    setNotice(null);
    const email = field(form, "email");
    const { user: added, link } = await api.addMember(workspace.id, email);
    element.reset();
    setNotice(<IssuedLink label={`Link for ${nameOf(added)}`} link={link} />);
    refresh();
  });
  const addByGitHub = useSubmit(async (form, element) => {
    setNotice(null);
    const { user: added } = await api.addMemberByGitHub(workspace.id, field(form, "login").trim().replace(/^@/, ""));
    element.reset();
    setNotice(
      <p role="status" className="saved">
        {nameOf(added)} joins at their next sign-in with GitHub.
      </p>,
    );
    refresh();
  });

  return (
    <div className="page page-settings">
      <PageHead crumbs={[workspaceCrumb(workspace)]} title="Members" />
      {workspace.isAdmin && (
        <Panel title="Add a member" id="add-member" description="By email, they get a one-time link to join; by GitHub login, they join at their next sign-in with GitHub.">
          <div className="form-columns">
            <form onSubmit={add.onSubmit}>
              <Field label="Email">
                <input name="email" type="email" required autoComplete="off" />
              </Field>
              <FormError error={add.error} />
              <Actions>
                <Button type="submit" variant="primary" disabled={add.busy}>
                  Add by email
                </Button>
              </Actions>
            </form>
            <form onSubmit={addByGitHub.onSubmit}>
              <Field label="GitHub login">
                <input name="login" required autoComplete="off" />
              </Field>
              <FormError error={addByGitHub.error} />
              <Actions>
                <Button type="submit" variant="primary" disabled={addByGitHub.busy}>
                  Add by GitHub login
                </Button>
              </Actions>
            </form>
          </div>
          {notice}
        </Panel>
      )}
      <FormError error={error} />
      {pending.length > 0 && (
        <Panel title="Added, not joined yet" id="pending-adds" className="panel-table">
          <table aria-labelledby="pending-adds-heading">
            <tbody>
              {pending.map((add) => (
                <tr key={`${add.user.id} ${add.addedVia}`}>
                  <td>
                    <span className="actor">
                      <Avatar actor={{ kind: "user", name: nameOf(add.user) }} />
                      {nameOf(add.user)}
                    </span>
                  </td>
                  <td className="muted small">
                    {add.addedVia === "email"
                      ? `by email, link valid until ${new Date(add.expiresAt).toLocaleString()}`
                      : "by GitHub login, joins at their next sign-in"}
                  </td>
                  <td className="cell-actions">
                    <Button
                      size="small"
                      onClick={() =>
                        act(async () => {
                          await api.cancelPendingAdd(workspace.id, add.user.id);
                          refresh();
                        })
                      }
                    >
                      Cancel add
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <Panel title="Members" id="members" className="panel-table">
        {members === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <table aria-label="Members">
            <tbody>
              {members.map((member) => (
                <tr key={member.user.id}>
                  <td>
                    <span className="actor">
                      <Avatar actor={{ kind: "user", name: nameOf(member.user) }} />
                      <span>
                        {nameOf(member.user)}
                        {member.user.githubLogin && member.user.email && <span className="muted"> @{member.user.githubLogin}</span>}
                        {member.user.id === user.id && <span className="muted"> (you)</span>}
                      </span>
                    </span>
                  </td>
                  <td className="muted small">{member.isAdmin ? "Admin" : "Member"}</td>
                  {workspace.isAdmin && (
                    <td className="cell-actions">
                      <Button
                        size="small"
                        onClick={() =>
                          act(async () => {
                            await api.setAdmin(workspace.id, member.user.id, !member.isAdmin);
                            refresh();
                            if (member.user.id === user.id) onChanged();
                          })
                        }
                      >
                        {member.isAdmin ? "Remove Admin" : "Make Admin"}
                      </Button>
                      <Menu label={`More for ${nameOf(member.user)}`}>
                        <MenuItem
                          onSelect={() =>
                            void act(async () => {
                              const link = await api.resetLink(workspace.id, member.user.id);
                              setNotice(<IssuedLink label={`Reset link for ${nameOf(member.user)}`} link={link} />);
                            })
                          }
                        >
                          Reset link
                        </MenuItem>
                        <MenuItem tone="danger" onSelect={() => setRemoving(member)}>
                          Remove from Workspace
                        </MenuItem>
                      </Menu>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!workspace.isAdmin && notice}
      </Panel>
      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(null)}
          title={`Remove ${nameOf(removing.user)} from ${workspace.name}?`}
          confirm="Remove"
          onConfirm={async () => {
            setError(null);
            await api.removeMember(workspace.id, removing.user.id);
            if (removing.user.id === user.id) onLeft();
            else refresh();
          }}
        >
          Their Tickets stay, and any assigned to them wait for an Admin to assign them to someone.
        </ConfirmDialog>
      )}
    </div>
  );
}
