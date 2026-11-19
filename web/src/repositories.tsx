import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type GitHubInstallation, type Project, type Repository } from "./api.js";
import { field } from "./forms.js";
import { useLatest } from "./live.js";
import { Actions, Banner, Button, Field, FormError, Panel } from "./ui/controls.js";

/**
 * The Repositories a Project lists as holding its code, added from those the GitHub App's
 * installations cover. Reloads whenever the Project changes, as on a rename on GitHub.
 */
export function RepositoriesSettings({ project }: { project: Project }) {
  const [repositories, setRepositories] = useState<Repository[] | undefined>(undefined);
  const [installations, setInstallations] = useState<GitHubInstallation[] | undefined>(undefined);
  const [installationsError, setInstallationsError] = useState<string | null>(null);
  const [noApp, setNoApp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useLatest();
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

  useEffect(() => {
    latest(api.repositories(project.id), setRepositories, (e) => setError(e.message));
  }, [project]);
  useEffect(() => {
    api.githubInstallations().then(setInstallations, (e: unknown) => {
      if (e instanceof ApiError && e.code === "github_not_set_up") setNoApp(true);
      else setInstallationsError(message(e));
    });
  }, []);

  const change = async (act: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await act();
      setRepositories(await api.repositories(project.id));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = Number(field(new FormData(event.currentTarget), "repository"));
    if (id) void change(() => api.addRepository(project.id, id));
  };

  const listed = new Set(repositories?.map((r) => r.id));
  const available = (installations ?? []).flatMap((i) => i.repositories).filter((r) => !listed.has(r.id));
  return (
    <Panel
      title="Repositories"
      id="repositories"
      description="The GitHub Repositories holding this Project's code. Their Pull Requests link to the Tickets whose keys they name."
    >
      <FormError error={error} />
      {repositories && repositories.length === 0 && <p className="muted">The Project lists no Repositories yet.</p>}
      {repositories && repositories.length > 0 && (
        <ul className="repositories">
          {repositories.map((repository) => (
            <li key={repository.id}>
              <span className="mono">{repository.fullName}</span>
              <Button
                variant="ghost"
                size="small"
                aria-label={`Remove ${repository.fullName}`}
                disabled={busy}
                onClick={() => void change(() => api.removeRepository(project.id, repository.id))}
              >
                Remove
              </Button>
              {repository.keyClash && (
                <Banner tone="warn">
                  A Project of another Workspace also lists {repository.fullName} under the key {project.key}, so a Pull Request
                  naming a key such as {project.key}-12 links to Tickets in both Projects. Which Project isn't shown, since it
                  isn't in this Workspace.
                </Banner>
              )}
            </li>
          ))}
        </ul>
      )}
      {noApp ? (
        <p className="muted">
          This installation has no GitHub App yet. Once an Admin creates it on the GitHub page and installs it on GitHub,
          its Repositories can be added here.
        </p>
      ) : installationsError ? (
        <FormError error={`Couldn't ask GitHub which Repositories the App is installed on: ${installationsError}`} />
      ) : !installations ? (
        <p className="muted">Asking GitHub which Repositories the App is installed on…</p>
      ) : available.length === 0 ? (
        <p className="muted">
          No other Repository is available. Install the GitHub App on more Repositories on GitHub to add them here.
        </p>
      ) : (
        <form onSubmit={add}>
          <Field label="Repository to add">
            <select name="repository" required disabled={busy}>
              {available.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.fullName}
                </option>
              ))}
            </select>
          </Field>
          <Actions>
            <Button type="submit" variant="primary" disabled={busy}>
              Add Repository
            </Button>
          </Actions>
        </form>
      )}
    </Panel>
  );
}
