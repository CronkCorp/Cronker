import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type User, type Workspace } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { ProjectScreen, WorkspaceHome } from "./projects.js";
import { Link, usePath } from "./router.js";
import { TicketScreen } from "./tickets.js";

type Screen =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "signIn"; notice?: string }
  | { kind: "workspace"; user: User; workspace: Workspace | null };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async (notice?: string) => {
    try {
      if (await api.setupNeeded()) return setScreen({ kind: "setup" });
      const me = await api.me();
      const first = me.workspaces[0];
      const workspace = first ? await api.workspace(first.id) : null;
      setScreen({ kind: "workspace", user: me.user, workspace });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return setScreen({ kind: "signIn", notice });
      setFailure(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
  switch (screen.kind) {
    case "loading":
      return <Centered title="Cronk">Loading…</Centered>;
    case "setup":
      return <SetupScreen onDone={() => setScreen({ kind: "signIn", notice: "Cronk is set up. Sign in to continue." })} />;
    case "signIn":
      return <SignInScreen notice={screen.notice} onSignedIn={() => load()} />;
    case "workspace":
      return (
        <WorkspaceScreen
          user={screen.user}
          workspace={screen.workspace}
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

function WorkspaceScreen({
  user,
  workspace,
  onSignedOut,
}: {
  user: User;
  workspace: Workspace | null;
  onSignedOut: () => void;
}) {
  const path = usePath();
  const { error, busy, onSubmit } = useSubmit(async () => {
    await api.signOut();
    onSignedOut();
  });
  const projectPath = /^\/projects\/([^/]+)(?:\/(list|settings))?\/?$/.exec(path);
  const ticketPath = /^\/tickets\/([^/]+)\/?$/.exec(path);
  return (
    <div className="shell">
      <header>
        <strong>{workspace ? <Link to="/">{workspace.name}</Link> : "Cronk"}</strong>
        <span className="spacer" />
        <span>{user.email}</span>
        <form onSubmit={onSubmit}>
          <button type="submit" disabled={busy}>
            Sign out
          </button>
        </form>
      </header>
      <main>
        {error && <p role="alert">{error}</p>}
        {workspace ? (
          projectPath ? (
            <ProjectScreen
              key={projectPath[1]}
              workspace={workspace}
              projectId={projectPath[1]!}
              view={(projectPath[2] as "list" | "settings" | undefined) ?? "board"}
            />
          ) : ticketPath ? (
            <TicketScreen key={ticketPath[1]} workspace={workspace} ticketId={ticketPath[1]!} />
          ) : (
            <WorkspaceHome workspace={workspace} />
          )
        ) : (
          <p>You don't belong to any Workspace yet.</p>
        )}
      </main>
    </div>
  );
}
