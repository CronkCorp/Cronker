import { useEffect, useState } from "react";
import { api, ApiError, type GitHubImport, type GitHubInstallation, type Project, type Repository } from "./api.js";
import { useSave } from "./forms.js";
import { useLatest } from "./live.js";
import { Banner, Button, FormError, Panel, Saved } from "./ui/controls.js";
import { Picker, type PickerOption } from "./ui/picker.js";

/**
 * The Repositories a Project lists as holding its code, added from those the GitHub App's
 * installations cover. Reloads whenever the Project changes, as on a rename on GitHub. Cronk
 * is asked which Repositories the App covers only once Add Repository is first opened; it
 * keeps GitHub's answer a few minutes, and Refresh asks GitHub afresh, as for a Repository
 * just installed there. An Admin imports each Repository's GitHub issues from here too.
 */
export function RepositoriesSettings({ project, isAdmin }: { project: Project; isAdmin: boolean }) {
  const [repositories, setRepositories] = useState<Repository[] | undefined>(undefined);
  // Whether the installation has a GitHub App, which Cronk answers without asking GitHub.
  const [hasApp, setHasApp] = useState<boolean | undefined>(undefined);
  const [installations, setInstallations] = useState<GitHubInstallation[] | undefined>(undefined);
  const [installationsError, setInstallationsError] = useState<string | null>(null);
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

  // Asks on the first opening, again on the next after a failure, and with Refresh.
  const askGitHub = (refresh = false) => {
    if ((installations && !refresh) || asking) return;
    setAsking(true);
    setInstallationsError(null);
    api
      .githubInstallations(refresh)
      .then(setInstallations, (e: unknown) => {
        // The App went away since the page asked Cronk.
        if (e instanceof ApiError && e.code === "github_not_set_up") setHasApp(false);
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
  // Cronk answers by account and owner/name; several installations are told apart by their account.
  const options: PickerOption[] = (installations ?? []).flatMap((installation) =>
    installation.repositories
      .filter((r) => !listed.has(r.id))
      .map((r) => ({
        value: String(r.id),
        label: r.fullName,
        group: installations!.length > 1 ? installation.account : undefined,
      })),
  );
  const notice = installationsError ? (
    <FormError error={`Couldn't ask GitHub which Repositories the App is installed on: ${installationsError}`} />
  ) : !installations || asking ? (
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
              <IssuesImport project={project} repository={repository} isAdmin={isAdmin} />
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
        <p className="muted">
          This installation has no GitHub App yet. Once an Admin creates it on the GitHub page and installs it on GitHub,
          its Repositories can be added here.
        </p>
      ) : hasApp === true ? (
        <div>
          <Picker
            label="Repository to add"
            onOpenChange={(open) => open && askGitHub()}
            options={options}
            notice={notice}
            footer={
              <>
                <span>Just installed the App on GitHub?</span>
                <Button variant="ghost" size="small" disabled={asking} onClick={() => askGitHub(true)}>
                  Refresh
                </Button>
              </>
            }
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

/** How often a running import's progress is asked for. */
const importPollMs = 2_000;

/**
 * Importing a Repository's GitHub issues into the Project: an Admin starts it, and its progress shows while it runs,
 * then how many issues it imported and skipped, or why it failed. Anyone sees the latest import.
 */
function IssuesImport({ project, repository, isAdmin }: { project: Project; repository: Repository; isAdmin: boolean }) {
  const [latest, setLatest] = useState<GitHubImport | null | undefined>(undefined);
  const { error, busy, save } = useSave();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = () =>
      api.latestImport(project.id, repository.id).then(
        ({ import: found }) => {
          if (stopped) return;
          setLatest(found);
          if (found?.state === "running") timer = setTimeout(ask, importPollMs);
        },
        () => undefined,
      );
    if (latest === undefined || latest?.state === "running") void ask();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [project.id, repository.id, latest?.id, latest?.state]);

  const running = latest?.state === "running";
  const issues = (n: number) => `${n} ${n === 1 ? "issue" : "issues"}`;
  const status = !latest
    ? null
    : latest.state === "running"
      ? `Importing issues… ${issues(latest.imported)} imported so far${latest.skipped ? `, ${latest.skipped} skipped` : ""}.`
      : latest.state === "done"
        ? `Imported ${issues(latest.imported)}; skipped ${latest.skipped} already imported.`
        : `The import stopped after ${issues(latest.imported)}: ${latest.error ?? "it failed."}`;
  return (
    <div className="repository-import">
      {isAdmin && (
        <Button
          variant="ghost"
          size="small"
          aria-label={`Import issues from ${repository.fullName}`}
          disabled={busy || running}
          onClick={() => void save(async () => setLatest(await api.startImport(project.id, repository.id)))}
        >
          Import issues
        </Button>
      )}
      {status && (
        <span className="muted small" role="status">
          {status}
        </span>
      )}
      <FormError error={error} />
    </div>
  );
}
