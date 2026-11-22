import { useEffect, useState } from "react";
import { api, type GitHubApp, type User, type GitHubChecklist, type GitHubInstallation, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { Centered, usePlace } from "./frame.js";
import { Actions, Banner, Button, buttonClass, Field, FormError, PageHead, Panel } from "./ui/controls.js";
import { returnAfterSignIn } from "./storage.js";
import { SettingsLayout } from "./ui/settings.js";

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
  github_account_taken: "That GitHub account is linked to another User already, so it wasn't linked to you.",
  github_already_linked: "You already have a GitHub account linked.",
  not_signed_in: "Sign in first, then link your GitHub account.",
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

/**
 * The signed-in User's GitHub account on their password page: the login once linked, else
 * a button that links one through GitHub, which sends the browser back here.
 */
export function GitHubAccountPanel({ user }: { user: User }) {
  const [app, setApp] = useState<GitHubApp | null | undefined>(undefined);
  // Cronk sends the browser back here with `github=linked`, or `github_link_error` when linking failed.
  const [outcome] = useState(() => {
    const error = takeQueryParameter("github_link_error");
    const linked = takeQueryParameter("github");
    return error ? { error: githubErrorMessage(error) } : { linked: linked === "linked" };
  });
  useEffect(() => {
    api.githubApp().then(setApp, () => setApp(null));
  }, []);
  return (
    <Panel
      title="GitHub account"
      id="github-account"
      description="Once linked, you can sign in with GitHub, and your merges on GitHub complete Tickets as Verified."
    >
      {user.githubLogin ? (
        <p>
          Linked to <strong className="mono">@{user.githubLogin}</strong>.
        </p>
      ) : app === null ? (
        <p>This installation has no GitHub App yet, so no GitHub account can be linked.</p>
      ) : app ? (
        <Actions>
          <a className={`${buttonClass("secondary")} button-github`} href="/api/github/link">
            Link GitHub account
          </a>
        </Actions>
      ) : null}
      {outcome.linked && user.githubLogin ? (
        <p role="status" className="saved">
          GitHub account linked.
        </p>
      ) : null}
      <FormError error={outcome.error ?? null} />
    </Panel>
  );
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
      className={`${buttonClass("secondary")} button-github`}
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
      <Field label="GitHub organization" hint="Leave it empty for your own account.">
        <input name="organization" autoComplete="off" pattern="[A-Za-z0-9\-]+" />
      </Field>
      <FormError error={error} />
      <Actions>
        <Button type="submit" variant="primary" disabled={busy}>
          {submitLabel}
        </Button>
      </Actions>
    </form>
  );
}

/** The step after setup: create the GitHub App now, or skip it. */
export function GitHubSetupStep({ onSkip }: { onSkip: () => void }) {
  return (
    <Centered title="Connect GitHub">
      <p className="muted">
        Cronk is set up and you're signed in. Create the installation's GitHub App now so people can sign in with
        GitHub, or skip this and do it later from the GitHub page.
      </p>
      <CreateAppForm submitLabel="Create GitHub App" />
      <Button variant="ghost" onClick={onSkip}>
        Skip for now
      </Button>
    </Centered>
  );
}

/** How GitHub's settings page names each permission Cronk asks for. */
const permissionNames: Record<string, string> = {
  emails: "Email addresses (account permission)",
  metadata: "Metadata",
  contents: "Contents",
  pull_requests: "Pull requests",
  checks: "Checks",
  statuses: "Commit statuses",
};

/** How GitHub's settings page names each access level. */
const accessNames: Record<string, string> = { read: "Read-only", write: "Read and write" };

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
    <ul className="checklist">
      {Object.entries(permissions).map(([name, access]) => (
        <li key={name}>
          {permissionNames[name] ?? name}: {accessNames[access] ?? access}
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
  if (error) return <FormError error={`Couldn't ask GitHub what the App has: ${error}`} />;
  if (!checklist) return <p className="muted">Asking GitHub what the App has…</p>;

  const { settingsUrl, missingPermissions, missingEvents, webhook, installationsNotAccepted } = checklist;
  const appComplete = Object.keys(missingPermissions).length === 0 && missingEvents.length === 0 && !webhook;
  return (
    <Panel title="What the App needs" id="checklist">
      {appComplete ? (
        <p>✓ The App has every permission, event and webhook setting Cronk needs.</p>
      ) : (
        <>
          <Banner tone="warn">
          <p>
            The App lacks some of what Cronk needs to work with Pull Requests and hear from GitHub. GitHub can't change an
            existing App from Cronk, so add these in <a href={settingsUrl}>the App's settings on GitHub</a>, save, and
            reload this page.
          </p>
          </Banner>
          {Object.keys(missingPermissions).length > 0 && (
            <>
              <h3>Permissions</h3>
              <PermissionList permissions={missingPermissions} />
            </>
          )}
          {missingEvents.length > 0 && (
            <>
              <h3>Subscribe to events</h3>
              <ul className="checklist">
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
              <div className="issued">
                <Field label="Webhook URL">
                  <input readOnly value={webhook.url} className="mono" onFocus={(event) => event.currentTarget.select()} />
                </Field>
                <Field
                  label="Webhook secret"
                  hint="Only Admins see the secret. Cronk refuses deliveries not signed with it. GitHub never shows a secret, so this stays listed until a delivery arrives signed with it; to check at once, redeliver one from the App's Advanced settings on GitHub."
                >
                  <input readOnly value={webhook.secret} className="mono" onFocus={(event) => event.currentTarget.select()} />
                </Field>
              </div>
            </>
          )}
        </>
      )}
      {installationsNotAccepted.length > 0 && (
        <>
          <h3>Installations that haven't accepted</h3>
          <p>Each installation's owner on GitHub accepts the App's new permissions on its page there. Until then, Cronk can't use the new permissions on its Repositories.</p>
          <ul className="checklist">
            {installationsNotAccepted.map((installation) => (
              <li key={installation.htmlUrl}>
                <a href={installation.htmlUrl}>{installation.account}</a> lacks
                <PermissionList permissions={installation.missingPermissions} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/**
 * Where the App is installed, and the Repositories each installation covers, as GitHub says now
 * rather than as Cronk keeps it, so an installation just made on GitHub shows on reloading.
 */
function Installations({ app }: { app: GitHubApp }) {
  const [installations, setInstallations] = useState<GitHubInstallation[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.githubInstallations(true).then(setInstallations, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <Panel title="Installations" id="installations" description="The accounts and organizations the App is installed on, and the Repositories each covers.">
      {error ? (
        <FormError error={`Couldn't ask GitHub where the App is installed: ${error}`} />
      ) : !installations ? (
        <p className="muted">Asking GitHub where the App is installed…</p>
      ) : installations.length === 0 ? (
        <p>
          The App isn't installed anywhere yet. Install it from <a href={app.htmlUrl}>its page on GitHub</a> on the
          accounts and organizations whose Repositories Cronk should read.
        </p>
      ) : (
        <ul className="side-list">
          {installations.map((installation) => (
            <li key={installation.account}>
              <strong>{installation.account}</strong>:{" "}
              <span className="mono small">{installation.repositories.map((r) => r.fullName).join(", ") || "no Repositories"}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** The installation's GitHub App: who it is, or, for Admins, creating it. */
export function GitHubPage({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  usePlace("github");
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
    <div className="page page-settings">
      <PageHead crumbs={[{ label: "Installation" }]} title="GitHub" />
      <FormError error={outcome.error} />
      {outcome.created && (
        <p role="status" className="saved">
          The GitHub App is created. People can now sign in with GitHub.
        </p>
      )}
      {app === undefined ? (
        <p className="muted">Loading…</p>
      ) : (
        <SettingsLayout
          sections={[
            {
              id: "app",
              label: "The App",
              children: app ? (
                <Panel title="The App" id="app">
                  <p>
                    This installation's GitHub App is <a href={app.htmlUrl}>{app.name}</a>, under the GitHub account {app.githubAccount}. People
                    sign in with GitHub through it, and Cronk reads the Pull Requests of the Repositories it's installed on.
                  </p>
                </Panel>
              ) : (
                <Panel title="The App" id="app" description="This installation has no GitHub App yet, so nobody can sign in with GitHub.">
                  {isAdmin ? <CreateAppForm submitLabel="Create GitHub App" /> : <p className="muted">An Admin can create it.</p>}
                </Panel>
              ),
            },
            !!app && isAdmin && { id: "checklist", label: "What the App needs", children: <AppChecklist /> },
            !!app && { id: "installations", label: "Installations", children: <Installations app={app} /> },
          ]}
        />
      )}
    </div>
  );
}
