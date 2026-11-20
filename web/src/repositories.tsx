import { useEffect, useState } from "react";
import { api, ApiError, type GitHubInstallation, type Project, type Repository } from "./api.js";
import { useSave } from "./forms.js";
import { useLatest } from "./live.js";
import { Banner, Button, FormError, Panel, Saved } from "./ui/controls.js";
import { Picker, type PickerOption } from "./ui/picker.js";

const noAppText =
  "This installation has no GitHub App yet. Once an Admin creates it on the GitHub page and installs it on GitHub, its Repositories can be added here.";

/**
 * The Repositories a Project lists as holding its code, added from those the GitHub App's
 * installations cover. Reloads whenever the Project changes, as on a rename on GitHub. GitHub
 * is asked which Repositories the App covers only once Add Repository is first opened.
 */
export function RepositoriesSettings({ project }: { project: Project }) {
  const [repositories, setRepositories] = useState<Repository[] | undefined>(undefined);
  // Whether the installation has a GitHub App, which Cronk answers without asking GitHub.
  const [hasApp, setHasApp] = useState<boolean | undefined>(undefined);
  const [installations, setInstallations] = useState<GitHubInstallation[] | undefined>(undefined);
  const [installationsError, setInstallationsError] = useState<string | null>(null);
  const [noApp, setNoApp] = useState(false);
  const [asking, setAsking] = useState(false);
  const { error, busy, saved, save } = useSave();
  const [loadError, setLoadError] = useState<string | null>(null);
  const latest = useLatest();

  useEffect(() => {
    latest(api.repositories(project.id), setRepositories, (e) => setLoadError(e.message));
  }, [project]);
  useEffect(() => {
    // If Cronk can't say, Add Repository is offered and asking GitHub says what's wrong.
    api.githubApp().then((app) => setHasApp(app !== null), () => setHasApp(true));
  }, []);

  // Asks GitHub on the first opening, and again on the next after a failure.
  const askGitHub = () => {
    if (installations || asking) return;
    setAsking(true);
    setInstallationsError(null);
    api
      .githubInstallations()
      .then(setInstallations, (e: unknown) => {
        if (e instanceof ApiError && e.code === "github_not_set_up") setNoApp(true);
        else setInstallationsError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setAsking(false));
  };

  const change = (act: () => Promise<unknown>) =>
    save(async () => {
      await act();
      setRepositories(await api.repositories(project.id));
      setLoadError(null);
    });

  const listed = new Set(repositories?.map((r) => r.id));
  // GitHub's answer comes sorted by owner/name; several installations are told apart by their account.
  const options: PickerOption[] = (installations ?? []).flatMap((installation) =>
    installation.repositories
      .filter((r) => !listed.has(r.id))
      .map((r) => ({
        value: String(r.id),
        label: r.fullName,
        group: installations!.length > 1 ? installation.account : undefined,
      })),
  );
  const notice = noApp ? (
    noAppText
  ) : installationsError ? (
    <FormError error={`Couldn't ask GitHub which Repositories the App is installed on: ${installationsError}`} />
  ) : !installations ? (
    "Asking GitHub which Repositories the App is installed on…"
  ) : options.length === 0 ? (
    "No other Repository is available. Install the GitHub App on more Repositories on GitHub to add them here."
  ) : undefined;

  return (
    <Panel
      title="Repositories"
      id="repositories"
      description="The GitHub Repositories holding this Project's code. Their Pull Requests link to the Tickets whose keys they name."
    >
      <FormError error={loadError ?? error} />
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
      {hasApp === false ? (
        <p className="muted">{noAppText}</p>
      ) : hasApp === true ? (
        <div>
          <Picker
            label="Repository to add"
            onOpenChange={(open) => open && askGitHub()}
            options={notice === undefined ? options : []}
            notice={notice}
            onPick={(id) => void change(() => api.addRepository(project.id, Number(id)))}
            trigger={
              <Button variant="primary" aria-haspopup="listbox" disabled={busy}>
                Add Repository
              </Button>
            }
          />
        </div>
      ) : null}
      <Saved shown={saved} />
    </Panel>
  );
}
