import { useEffect, useState } from "react";
import { api, type GitHubApp, type GitHubChecklist, type GitHubInstallation, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { returnAfterSignIn } from "./storage.js";

/** What the codes Cronk sends the browser back with mean, for whoever is signing in or creating the App. */
const githubErrors: Record<string, string> = {
  unknown_github_user:
    "No User has that GitHub account. Ask an Admin to add you to their Workspace by your GitHub login.",
  invalid_state: "That took too long or started in another browser. Try again.",
  github_denied: "GitHub didn't sign you in.",
  github_not_set_up: "This installation has no GitHub App yet, so nobody can sign in with GitHub.",
  github_unavailable: "GitHub couldn't be reached. Try again.",
  github_app_exists: "This installation already has its GitHub App.",
  no_secret_key: "Cronk has no CRONK_SECRET_KEY to encrypt the App's credentials with. Whoever runs Cronk must set it first.",
};

export function githubErrorMessage(code: string): string {
  return githubErrors[code] ?? "Something went wrong with GitHub. Try again.";
}

/** The query parameter a page was opened with, removed from the address so a reload doesn't show it again. */
export function takeQueryParameter(name: string): string | null {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(name);
  if (value !== null) {
    params.delete(name);
    const rest = params.toString();
    // Only the query changes, so nothing routed on the path needs telling.
    window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
  }
  return value;
}

/** Posts the manifest to GitHub from the browser, as GitHub's manifest flow needs. GitHub sends the browser back to Cronk. */
async function createApp(githubOrganization?: string): Promise<void> {
  const { url, manifest } = await api.startGitHubApp(githubOrganization || undefined);
  const form = document.createElement("form");
  form.method = "post";
  form.action = url;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.append(input);
  document.body.append(form);
  form.submit();
}

/** "Sign in with GitHub", shown once the installation has its GitHub App. */
export function GitHubSignIn({ label = "Sign in with GitHub", returnTo }: { label?: string; returnTo?: string }) {
  const [app, setApp] = useState<GitHubApp | null>(null);
  useEffect(() => {
    api.githubApp().then(setApp, () => setApp(null));
  }, []);
  if (!app) return null;
  return (
    <a
      className="button"
      href="/api/github/sign-in"
      onClick={() => {
        // GitHub sends the browser back to `/`; carry on from here once signed in.
        if (returnTo) returnAfterSignIn(returnTo);
      }}
    >
      {label}
    </a>
  );
}

function CreateAppForm({ submitLabel }: { submitLabel: string }) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await createApp(field(form, "organization").trim());
  });
  return (
    <form onSubmit={onSubmit}>
      <label>
        GitHub organization (leave empty for your own account)
        <input name="organization" autoComplete="off" pattern="[A-Za-z0-9\-]+" />
      </label>
      {error && <p role="alert">{error}</p>}
      <button type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}

/** The step after setup: create the GitHub App now, or skip it. */
export function GitHubSetupStep({ onSkip }: { onSkip: () => void }) {
  return (
    <main className="centered">
      <h1>Connect GitHub</h1>
      <p>
        Cronk is set up and you're signed in. Create the installation's GitHub App now so people can sign in with
        GitHub, or skip this and do it later from the GitHub page.
      </p>
      <CreateAppForm submitLabel="Create GitHub App" />
      <p>
        <button type="button" className="secondary" onClick={onSkip}>
          Skip for now
        </button>
      </p>
    </main>
  );
}

/** How GitHub's settings page names each permission Cronk asks for. */
const permissionNames: Record<string, string> = {
  emails: "Email addresses (account permission)",
  metadata: "Metadata",
  pull_requests: "Pull requests",
  checks: "Checks",
  statuses: "Commit statuses",
};

/** How GitHub's settings page names each event Cronk subscribes to. */
const eventNames: Record<string, string> = {
  pull_request: "Pull request",
  pull_request_review: "Pull request review",
  check_run: "Check run",
  check_suite: "Check suite",
  status: "Status",
  repository: "Repository",
};

function PermissionList({ permissions }: { permissions: Record<string, string> }) {
  return (
    <ul>
      {Object.entries(permissions).map(([name, access]) => (
        <li key={name}>
          {permissionNames[name] ?? name}: {access === "read" ? "Read-only" : access}
        </li>
      ))}
    </ul>
  );
}

/** For Admins: what the App lacks, to add by hand in its settings on GitHub. */
function AppChecklist() {
  const [checklist, setChecklist] = useState<GitHubChecklist | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.githubChecklist().then(setChecklist, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <p role="alert">Couldn't ask GitHub what the App has: {error}</p>;
  if (!checklist) return <p>Asking GitHub what the App has…</p>;

  const { settingsUrl, missingPermissions, missingEvents, webhook, installationsNotAccepted } = checklist;
  const appComplete = Object.keys(missingPermissions).length === 0 && missingEvents.length === 0 && !webhook;
  return (
    <section aria-labelledby="checklist-heading">
      <h2 id="checklist-heading">What the App needs</h2>
      {appComplete ? (
        <p>The App has every permission, event and webhook setting Cronk needs.</p>
      ) : (
        <>
          <p>
            The App lacks some of what Cronk needs to read Pull Requests and hear from GitHub. GitHub can't change an
            existing App from Cronk, so add these in <a href={settingsUrl}>the App's settings on GitHub</a>, save, and
            reload this page.
          </p>
          {Object.keys(missingPermissions).length > 0 && (
            <>
              <h3>Permissions</h3>
              <PermissionList permissions={missingPermissions} />
            </>
          )}
          {missingEvents.length > 0 && (
            <>
              <h3>Subscribe to events</h3>
              <ul>
                {missingEvents.map((event) => (
                  <li key={event}>{eventNames[event] ?? event}</li>
                ))}
              </ul>
            </>
          )}
          {webhook && (
            <>
              <h3>Webhook</h3>
              <p>Check Active, and paste:</p>
              <div className="issued-link">
              <label>
                Webhook URL
                <input readOnly value={webhook.url} onFocus={(event) => event.currentTarget.select()} />
              </label>
              <label>
                Webhook secret
                <input readOnly value={webhook.secret} onFocus={(event) => event.currentTarget.select()} />
              </label>
              <small>
                Only Admins see the secret. Cronk refuses deliveries not signed with it. GitHub never shows a secret, so
                this stays listed until a delivery arrives signed with it; to check at once, redeliver one from the
                App's Advanced settings on GitHub.
              </small>
              </div>
            </>
          )}
        </>
      )}
      {installationsNotAccepted.length > 0 && (
        <>
          <h3>Installations that haven't accepted</h3>
          <p>Each installation's owner on GitHub accepts the App's new permissions on its page there. Until then, Cronk can't read its Pull Requests.</p>
          <ul>
            {installationsNotAccepted.map((installation) => (
              <li key={installation.htmlUrl}>
                <a href={installation.htmlUrl}>{installation.account}</a> lacks
                <PermissionList permissions={installation.missingPermissions} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Where the App is installed, and the Repositories each installation covers. */
function Installations({ app }: { app: GitHubApp }) {
  const [installations, setInstallations] = useState<GitHubInstallation[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.githubInstallations().then(setInstallations, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <section aria-labelledby="installations-heading">
      <h2 id="installations-heading">Installations</h2>
      {error ? (
        <p role="alert">Couldn't ask GitHub where the App is installed: {error}</p>
      ) : !installations ? (
        <p>Asking GitHub where the App is installed…</p>
      ) : installations.length === 0 ? (
        <p>
          The App isn't installed anywhere yet. Install it from <a href={app.htmlUrl}>its page on GitHub</a> on the
          accounts and organizations whose Repositories Cronk should read.
        </p>
      ) : (
        <ul>
          {installations.map((installation) => (
            <li key={installation.account}>
              {installation.account}: {installation.repositories.map((r) => r.fullName).join(", ") || "no Repositories"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The installation's GitHub App: who it is, or, for Admins, creating it. */
export function GitHubPage({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  const [app, setApp] = useState<GitHubApp | null | undefined>(undefined);
  const [outcome] = useState(() => {
    const error = takeQueryParameter("error");
    const created = takeQueryParameter("created");
    return error ? { error: githubErrorMessage(error) } : created ? { created: true } : {};
  });
  useEffect(() => {
    api.githubApp().then(setApp, () => setApp(null));
  }, []);
  const isAdmin = workspaces.some((w) => w.isAdmin);

  return (
    <section className="github-page">
      <h1>GitHub</h1>
      {outcome.error && <p role="alert">{outcome.error}</p>}
      {outcome.created && <p role="status">The GitHub App is created. People can now sign in with GitHub.</p>}
      {app === undefined ? (
        <p>Loading…</p>
      ) : app ? (
        <>
          <p>
            This installation's GitHub App is <a href={app.htmlUrl}>{app.name}</a>, under the GitHub account {app.githubAccount}. People
            sign in with GitHub through it, and Cronk reads the Pull Requests of the Repositories it's installed on.
          </p>
          {isAdmin && <AppChecklist />}
          <Installations app={app} />
        </>
      ) : (
        <>
          <p>This installation has no GitHub App yet, so nobody can sign in with GitHub.</p>
          {isAdmin ? (
            <CreateAppForm submitLabel="Create GitHub App" />
          ) : (
            <p>An Admin can create it.</p>
          )}
        </>
      )}
    </section>
  );
}
