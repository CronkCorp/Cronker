import { useEffect, useState } from "react";
import { api, type GitHubApp, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";

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
export function GitHubSignIn({ label = "Sign in with GitHub" }: { label?: string }) {
  const [app, setApp] = useState<GitHubApp | null>(null);
  useEffect(() => {
    api.githubApp().then(setApp, () => setApp(null));
  }, []);
  if (!app) return null;
  return (
    <a className="button" href="/api/github/sign-in">
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
    <section className="narrow">
      <h1>GitHub</h1>
      {outcome.error && <p role="alert">{outcome.error}</p>}
      {outcome.created && <p role="status">The GitHub App is created. People can now sign in with GitHub.</p>}
      {app === undefined ? (
        <p>Loading…</p>
      ) : app ? (
        <p>
          This installation's GitHub App is <a href={app.htmlUrl}>{app.name}</a>, under the GitHub account {app.githubAccount}. People sign in
          with GitHub through it.
        </p>
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
