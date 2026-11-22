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
import { AccountSettingsPage } from "./account.js";
import { GitHubPage, GitHubSetupStep, GitHubSignIn, githubErrorMessage, takeQueryParameter } from "./github.js";
import { DecisionScreen, WorkspaceDecisions } from "./decisions.js";
import { DocumentScreen, WorkspaceDocuments } from "./documents.js";
import { TermScreen, WorkspaceGlossary } from "./terms.js";
import { InboxScreen } from "./inbox.js";
import { ProjectScreen, WorkspaceHome } from "./projects.js";
import { navigate, replace, usePath } from "./router.js";
import { addresses } from "./addresses.js";
import { finder, OldAddress, oldAddress, parseAddress, Resolve } from "./routes.js";
import { ArtifactScreen, WorkspaceArtifacts } from "./artifacts.js";
import { RunnersScreen } from "./runners.js";
import { SearchScreen } from "./search.js";
import { takeReturnAfterSignIn } from "./storage.js";
import { TicketScreen } from "./tickets.js";
import { TranscriptScreen } from "./transcripts.js";
import { Avatar } from "./ui/actor.js";
import { Actions, Button, EmptyState, Field, FormError, PageHead, Panel, Saved, workspaceCrumb } from "./ui/controls.js";
import { SettingsLayout } from "./ui/settings.js";
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
        <Actions>
          <Button type="submit" variant="primary" disabled={busy}>
            Set up
          </Button>
        </Actions>
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
        <Actions>
          <Button type="submit" variant="primary" disabled={busy}>
            {joining ? "Join" : "Set password"}
          </Button>
        </Actions>
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
  const parsed = parseAddress(path);
  const old = oldAddress(path, workspaces);
  const routed = !old && parsed ? workspaces.find((w) => w.slug === parsed.slug.toLowerCase()) : undefined;

  // The Workspace on screen: the one in the path, else the last one shown (pages such as Runners carry none in
  // their path), else the first.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (routed) setSelectedId(routed.id);
  }, [routed]);
  const current = routed ?? workspaces.find((w) => w.id === selectedId) ?? workspaces[0];

  useEffect(() => {
    if (path === "/" && workspaces[0]) replace(addresses.workspace(workspaces[0]));
  }, [path, workspaces]);
  // The password page became a section of the User's settings: an old link to it opens that section.
  useEffect(() => {
    if (path === "/password") replace(`/account${window.location.search}#password`);
  }, [path]);
  // A Workspace's slug in another letter case leads to the slug itself.
  useEffect(() => {
    if (routed && parsed && parsed.slug !== routed.slug) {
      replace(`/${routed.slug}${path.slice(parsed.slug.length + 1)}${window.location.search}${window.location.hash}`);
    }
  }, [routed, parsed, path]);

  const nothing = <PlacelessEmptyState title="Nothing is here.">The page may have moved, or you may not see it.</PlacelessEmptyState>;
  const route = routed ? parsed!.route : null;
  const find = routed && route ? finder(routed, route) : null;

  let page: ReactNode;
  if (path === "/workspaces/new") {
    page = (
      <NewWorkspace
        onCreated={(created) => {
          navigate(addresses.workspace(created));
          reload();
        }}
      />
    );
  } else if (path === "/account" || path === "/password") {
    page = <AccountSettingsPage user={user} onChanged={reload} />;
  } else if (path === "/github") {
    page = <GitHubPage workspaces={workspaces} />;
  } else if (path === "/runners") {
    page = <RunnersScreen workspaces={workspaces} />;
  } else if (old) {
    page = <OldAddress key={path} find={old} failed={nothing} />;
  } else if (routed && route && find) {
    const workspace = routed;
    const screen = (id: string): ReactNode => {
      switch (route.kind) {
        case "project":
          return <ProjectScreen key={`${workspace.id} ${id}`} workspace={workspace} user={user} projectId={id} view={route.view ?? "board"} />;
        case "ticket":
          return <TicketScreen key={`${workspace.id} ${id}`} workspace={workspace} user={user} ticketId={id} />;
        case "decision":
          return <DecisionScreen key={`${workspace.id} ${id}`} workspace={workspace} decisionId={id} />;
        case "term":
          return <TermScreen key={`${workspace.id} ${id}`} workspace={workspace} termId={id} />;
        case "document":
          return <DocumentScreen key={`${workspace.id} ${id}`} workspace={workspace} documentId={id} />;
        case "artifact":
          return <ArtifactScreen key={`${workspace.id} ${id}`} workspace={workspace} user={user} artifactId={id} />;
        case "transcript":
          return <TranscriptScreen key={`${workspace.id} ${id}`} workspace={workspace} transcriptId={id} />;
        default:
          return nothing;
      }
    };
    page = (
      <Resolve key={`${workspace.id} ${route.kind}`} name={path} find={find} failed={nothing}>
        {screen}
      </Resolve>
    );
  } else if (routed && route?.kind === "agent") {
    page = <AgentScreen key={`${routed.id} ${route.agentId}`} workspace={routed} agentId={route.agentId} />;
  } else if (routed && route?.kind === "workspace") {
    const workspace = routed;
    switch (route.page) {
      case "glossary":
        page = <WorkspaceGlossary key={workspace.id} workspace={workspace} />;
        break;
      case "decisions":
        page = <WorkspaceDecisions key={workspace.id} workspace={workspace} />;
        break;
      case "artifacts":
        page = <WorkspaceArtifacts key={workspace.id} workspace={workspace} />;
        break;
      case "documents":
        page = <WorkspaceDocuments key={workspace.id} workspace={workspace} />;
        break;
      case "search":
        page = <SearchScreen key={workspace.id} workspace={workspace} />;
        break;
      case "inbox":
        page = <InboxScreen key={workspace.id} workspace={workspace} user={user} />;
        break;
      case "agents":
        page = <Agents key={workspace.id} user={user} workspace={workspace} />;
        break;
      case "settings":
        page = <WorkspaceSettingsPage key={workspace.id} workspace={workspace} onChanged={reload} />;
        break;
      case "members":
        page = (
          <Members
            key={workspace.id}
            user={user}
            workspace={workspace}
            onChanged={reload}
            onLeft={() => {
              navigate("/");
              reload();
            }}
          />
        );
        break;
      default:
        page = <WorkspaceHome key={workspace.id} workspace={workspace} />;
    }
  } else if (current && path === "/") {
    page = <WorkspaceHome key={current.id} workspace={current} />;
  } else if (workspaces.length === 0 && path === "/") {
    page = <PlacelessEmptyState title="You don't belong to any Workspace yet.">Create one from the Workspace menu, or ask an Admin to add you.</PlacelessEmptyState>;
  } else {
    page = nothing;
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
    const slug = field(form, "slug").trim();
    onCreated(await api.createWorkspace({ name: field(form, "name"), ...(slug ? { slug } : {}) }));
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
          <Field
            label="Slug"
            hint="Its name in addresses, such as /acme/tickets/RP-12: lower case letters, digits and dashes. Made from its name when left empty. It can't be changed later."
          >
            <input name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={40} autoComplete="off" spellCheck={false} />
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
      <SettingsLayout
        sections={[
          {
            id: "workspace-name",
            label: "Name",
            children: (
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
            ),
          },
          !!settings && {
            id: "model-ids",
            label: "Model ids",
            children: <ModelIds workspace={workspace} settings={settings} onSaved={setSettings} />,
          },
          !!settings && {
            id: "lost-runs",
            label: "Lost Runs",
            children: (
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
            ),
          },
        ]}
      />
    </div>
  );
}

/**
 * The exact model id each model label stands for in the Workspace, which a Runner setup gives each routine. Labels
 * match a Step's model ignoring case.
 */
function ModelIds({
  workspace,
  settings,
  onSaved,
}: {
  workspace: WorkspaceSummary;
  settings: WorkspaceSettings;
  onSaved: (settings: WorkspaceSettings) => void;
}) {
  const [rows, setRows] = useState(() => settings.modelIds.map((m, key) => ({ ...m, key })));
  const [next, setNext] = useState(settings.modelIds.length);
  const [saved, setSaved] = useState(false);
  const save = useSubmit(async () => {
    setSaved(false);
    const changed = await api.changeWorkspaceSettings(workspace.id, {
      modelIds: rows.map(({ label, modelId }) => ({ label, modelId })),
    });
    onSaved(changed);
    setSaved(true);
  });
  const edit = (key: number, change: Partial<{ label: string; modelId: string }>) =>
    setRows((all) => all.map((row) => (row.key === key ? { ...row, ...change } : row)));
  return (
    <Panel
      title="Model ids"
      id="model-ids"
      description="The exact model a Step's model label stands for. Set up with Claude Code gives each routine the model id of its label; routines already made keep theirs."
    >
      <form onSubmit={save.onSubmit} className="model-ids">
        {rows.map((row) => (
          <div key={row.key} className="form-row model-id-row" role="group" aria-label={`Model id of ${row.label || "a new label"}`}>
            <Field label="Model label">
              <input required className="mono" value={row.label} onChange={(event) => edit(row.key, { label: event.target.value })} />
            </Field>
            <Field label="Model id">
              <input required className="mono" value={row.modelId} onChange={(event) => edit(row.key, { modelId: event.target.value })} />
            </Field>
            <Button variant="ghost" size="small" onClick={() => setRows((all) => all.filter((r) => r.key !== row.key))}>
              Remove
            </Button>
          </div>
        ))}
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              setRows((all) => [...all, { label: "", modelId: "", key: next }]);
              setNext(next + 1);
            }}
          >
            Add a model label
          </Button>
        </div>
        <FormError error={save.error} />
        <Actions>
          <Button type="submit" variant="primary" disabled={save.busy}>
            Save model ids
          </Button>
          <Saved shown={saved} />
        </Actions>
      </form>
    </Panel>
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
  const [savedAdmin, setSavedAdmin] = useState(false);
  const refresh = useCallback(() => {
    api.members(workspace.id).then(setMembers, (e: Error) => setError(e.message));
    if (workspace.isAdmin) api.pendingAdds(workspace.id).then(setPending, (e: Error) => setError(e.message));
    else setPending([]);
  }, [workspace.id, workspace.isAdmin]);
  useEffect(refresh, [refresh]);

  const act = async (action: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    setSavedAdmin(false);
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
      <FormError error={error} />
      <SettingsLayout
        sections={[
          workspace.isAdmin && {
            id: "add-member",
            label: "Add a member",
            children: (
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
            ),
          },
          pending.length > 0 && {
            id: "pending-adds",
            label: "Added, not joined yet",
            children: (
              <Panel title="Added, not joined yet" id="pending-adds" className="panel-flush">
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
                          <div>
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
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            ),
          },
          {
            id: "members",
            label: "Members",
            children: (
            <Panel title="Members" id="members" className="panel-flush">
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
                            <div>
                              <Button
                                size="small"
                                onClick={() =>
                                  act(async () => {
                                    await api.setAdmin(workspace.id, member.user.id, !member.isAdmin);
                                    setSavedAdmin(true);
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
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Saved shown={savedAdmin} />
              {!workspace.isAdmin && notice}
            </Panel>
            ),
          },
        ]}
      />
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
