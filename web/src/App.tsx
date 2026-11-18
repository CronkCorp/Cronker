import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  api,
  ApiError,
  type Link as LinkInfo,
  type LinkDetails,
  type Member,
  type User,
  type WorkspaceSummary,
} from "./api.js";
import { field, useSubmit } from "./forms.js";
import { ProjectScreen, WorkspaceHome } from "./projects.js";
import { Link, navigate, replace, usePath } from "./router.js";

type Screen =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "signIn"; notice?: string }
  | { kind: "signedIn"; user: User; workspaces: WorkspaceSummary[] };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [failure, setFailure] = useState<string | null>(null);
  const path = usePath();
  // Links Cronk hands out open `/link`, with their secret in the fragment.
  const onLinkPage = path === "/link";

  const load = useCallback(async (notice?: string) => {
    try {
      if (await api.setupNeeded()) return setScreen({ kind: "setup" });
      const me = await api.me();
      setScreen({ kind: "signedIn", user: me.user, workspaces: me.workspaces });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return setScreen({ kind: "signIn", notice });
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    if (!onLinkPage) void load();
  }, [load, onLinkPage]);

  if (failure) {
    return (
      <Centered title="Cronk can't be reached">
        <p role="alert">{failure}</p>
        <button
          type="button"
          onClick={() => {
            setFailure(null);
            setScreen({ kind: "loading" });
            void load();
          }}
        >
          Try again
        </button>
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
  switch (screen.kind) {
    case "loading":
      return <Centered title="Cronk">Loading…</Centered>;
    case "setup":
      return <SetupScreen onDone={() => setScreen({ kind: "signIn", notice: "Cronk is set up. Sign in to continue." })} />;
    case "signIn":
      return <SignInScreen notice={screen.notice} onSignedIn={() => load()} />;
    case "signedIn":
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

function Centered({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="centered">
      <h1>{title}</h1>
      {children}
    </main>
  );
}

function SetupScreen({ onDone }: { onDone: () => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api.setUp({
      setupCode: field(form, "setupCode"),
      email: field(form, "email"),
      password: field(form, "password"),
      workspaceName: field(form, "workspaceName"),
    });
    onDone();
  });
  return (
    <Centered title="Set up Cronk">
      <p>Enter the setup code from Cronk's log, then create the first User and their Workspace.</p>
      <form onSubmit={onSubmit}>
        <label>
          Setup code
          <input name="setupCode" required autoComplete="off" />
        </label>
        <label>
          Email
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <label>
          Password
          <input name="password" type="password" required minLength={8} autoComplete="new-password" />
        </label>
        <label>
          Workspace name
          <input name="workspaceName" required />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Set up
        </button>
      </form>
    </Centered>
  );
}

function SignInScreen({ notice, onSignedIn }: { notice?: string; onSignedIn: () => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api.signIn(field(form, "email"), field(form, "password"));
    onSignedIn();
  });
  return (
    <Centered title="Sign in to Cronk">
      {notice && <p role="status">{notice}</p>}
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <label>
          Password
          <input name="password" type="password" required autoComplete="current-password" />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Sign in
        </button>
      </form>
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
        <p>It has been used, has expired or never existed. Ask an Admin of your Workspace for a new one.</p>
      </Centered>
    );
  }
  const joining = details.kind === "join";
  return (
    <Centered title={joining ? `Join ${details.workspace?.name}` : "Set a new password"}>
      <p>
        {joining ? "You're joining as " : "For "}
        <strong>{details.email}</strong>.
      </p>
      <form onSubmit={onSubmit}>
        <input type="hidden" name="username" value={details.email} autoComplete="username" />
        {details.setsPassword ? (
          <label>
            Choose a password
            <input name="password" type="password" required minLength={8} autoComplete="new-password" />
          </label>
        ) : (
          <label>
            Your password
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
        )}
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          {joining ? "Join" : "Set password"}
        </button>
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
  const { error, busy, onSubmit } = useSubmit(async () => {
    await api.signOut();
    onSignedOut();
  });
  const workspacePath = /^\/workspaces\/([^/]+)(\/members)?\/?$/.exec(path);
  const projectPath = /^\/projects\/([^/]+)(?:\/(list|settings))?\/?$/.exec(path);
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
  } else if (current && projectPath) {
    page = (
      <ProjectScreen
        key={`${current.id} ${projectPath[1]}`}
        workspace={current}
        projectId={projectPath[1]!}
        view={(projectPath[2] as "list" | "settings" | undefined) ?? "board"}
        onOtherWorkspace={(workspaceId) => {
          if (!workspaces.some((w) => w.id === workspaceId)) return false;
          setSelectedId(workspaceId);
          return true;
        }}
      />
    );
  } else if (current && workspacePath?.[2]) {
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
    page = <p>You don't belong to any Workspace yet.</p>;
  } else {
    page = <p>Nothing is here.</p>;
  }

  return (
    <div className="shell">
      <header>
        <strong>{current ? <Link to={`/workspaces/${current.id}`}>{current.name}</Link> : "Cronk"}</strong>
        {workspaces.length > 1 && (
          <select
            aria-label="Workspace"
            value={current?.id ?? ""}
            onChange={(event) => navigate(`/workspaces/${event.target.value}`)}
          >
            {!current && <option value="">Choose a Workspace</option>}
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <nav>
          {current && <Link to={`/workspaces/${current.id}/members`}>Members</Link>}
          <Link to="/workspaces/new">New Workspace</Link>
        </nav>
        <span className="spacer" />
        <Link to="/password">{user.email}</Link>
        <form onSubmit={onSubmit}>
          <button type="submit" disabled={busy}>
            Sign out
          </button>
        </form>
      </header>
      <main>
        {error && <p role="alert">{error}</p>}
        {page}
      </main>
    </div>
  );
}

function NewWorkspace({ onCreated }: { onCreated: (workspace: WorkspaceSummary) => void }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    onCreated(await api.createWorkspace(field(form, "name")));
  });
  return (
    <section className="narrow">
      <h1>New Workspace</h1>
      <p>You'll be its Admin, and can add Users to it.</p>
      <form onSubmit={onSubmit}>
        <label>
          Workspace name
          <input name="name" required />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={busy}>
          Create Workspace
        </button>
      </form>
    </section>
  );
}

function ChangePassword() {
  const [done, setDone] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async (form, element) => {
    setDone(false);
    await api.changePassword(field(form, "currentPassword"), field(form, "newPassword"));
    element.reset();
    setDone(true);
  });
  return (
    <section className="narrow">
      <h1>Change your password</h1>
      <form onSubmit={onSubmit}>
        <label>
          Current password
          <input name="currentPassword" type="password" required autoComplete="current-password" />
        </label>
        <label>
          New password
          <input name="newPassword" type="password" required minLength={8} autoComplete="new-password" />
        </label>
        {error && <p role="alert">{error}</p>}
        {done && <p role="status">Password changed. Your other sign-ins have ended.</p>}
        <button type="submit" disabled={busy}>
          Change password
        </button>
      </form>
    </section>
  );
}

function IssuedLink({ label, link }: { label: string; link: LinkInfo }) {
  return (
    <div className="issued-link">
      <label>
        {label}
        <input readOnly value={link.url} onFocus={(event) => event.currentTarget.select()} />
      </label>
      <small>Pass it on yourself. It works once, until {new Date(link.expiresAt).toLocaleString()}.</small>
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
  const [members, setMembers] = useState<Member[] | null>(null);
  const [notice, setNotice] = useState<ReactNode>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    api.members(workspace.id).then(setMembers, (e: Error) => setError(e.message));
  }, [workspace.id]);
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

  const rename = useSubmit(async (form) => {
    await api.renameWorkspace(workspace.id, field(form, "name"));
    onChanged();
  });
  const add = useSubmit(async (form, element) => {
    setNotice(null);
    const email = field(form, "email");
    const { user: added, link } = await api.addMember(workspace.id, email);
    element.reset();
    setNotice(<IssuedLink label={`Link for ${added.email}`} link={link} />);
    refresh();
  });

  return (
    <section>
      <h1>{workspace.name}: members</h1>
      {workspace.isAdmin && (
        <div className="admin-forms">
          <form onSubmit={rename.onSubmit}>
            <label>
              Workspace name
              <input name="name" required defaultValue={workspace.name} />
            </label>
            {rename.error && <p role="alert">{rename.error}</p>}
            <button type="submit" disabled={rename.busy}>
              Rename
            </button>
          </form>
          <form onSubmit={add.onSubmit}>
            <label>
              Email
              <input name="email" type="email" required autoComplete="off" />
            </label>
            {add.error && <p role="alert">{add.error}</p>}
            <button type="submit" disabled={add.busy}>
              Add
            </button>
          </form>
        </div>
      )}
      {notice}
      {error && <p role="alert">{error}</p>}
      {members === null ? (
        <p>Loading…</p>
      ) : (
        <table>
          <tbody>
            {members.map((member) => (
              <tr key={member.user.id}>
                <td>
                  {member.user.email}
                  {member.user.id === user.id && " (you)"}
                </td>
                <td>{member.isAdmin ? "Admin" : ""}</td>
                {workspace.isAdmin && (
                  <td className="actions">
                    <button
                      type="button"
                      onClick={() =>
                        act(async () => {
                          await api.setAdmin(workspace.id, member.user.id, !member.isAdmin);
                          refresh();
                          if (member.user.id === user.id) onChanged();
                        })
                      }
                    >
                      {member.isAdmin ? "Remove Admin" : "Make Admin"}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        act(async () => {
                          const link = await api.resetLink(workspace.id, member.user.id);
                          setNotice(<IssuedLink label={`Reset link for ${member.user.email}`} link={link} />);
                        })
                      }
                    >
                      Reset link
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        act(async () => {
                          await api.removeMember(workspace.id, member.user.id);
                          if (member.user.id === user.id) onLeft();
                          else refresh();
                        })
                      }
                    >
                      Remove from Workspace
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
