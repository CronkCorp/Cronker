import { useEffect, useState, type FormEvent } from "react";
import { api, type ProjectSummary, type SearchKind, type SearchResult, type Workspace } from "./api.js";
import { usePlace } from "./frame.js";
import { useLatest } from "./live.js";
import { Link, navigate, usePath, useQuery } from "./router.js";
import { EmptyState, FormError, PageHead, workspaceCrumb } from "./ui/controls.js";
import { Chip, Key } from "./ui/labels.js";
import { useAddresses, type Addresses } from "./addresses.js";

/** How many results of each kind a search gives at most, as the API does. */
const perKind = 20;

/** Where a search of the Workspace shows its results, narrowed to a Project when one is given, archived Tickets included when asked. */
function searchPage(to: Addresses, q: string, project?: string, archived = false): string {
  const query = new URLSearchParams({ q });
  if (project) query.set("project", project);
  if (archived) query.set("archived", "include");
  return to.search(`${query}`);
}

/** The sidebar's search box: Enter opens the Workspace's results page. */
export function SearchBox() {
  const path = usePath();
  const to = useAddresses();
  const shown = useQuery().get("q") ?? "";
  const onResults = path === to.workspace("search");
  const [q, setQ] = useState(onResults ? shown : "");
  // Following a link to other results, or going back to them, shows their words in the box.
  useEffect(() => {
    if (onResults) setQ(shown);
  }, [onResults, shown]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (q.trim()) navigate(searchPage(to, q.trim()));
  };
  return (
    <form role="search" aria-label="Workspace" className="sidebar-search" onSubmit={submit}>
      <input type="search" aria-label="Search" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
    </form>
  );
}

const groups: { kind: SearchKind; heading: string }[] = [
  { kind: "ticket", heading: "Tickets" },
  { kind: "document", heading: "Documents" },
  { kind: "report", heading: "Reports" },
  { kind: "term", heading: "Terms" },
  { kind: "decision", heading: "Decisions" },
  { kind: "artifact", heading: "Artifacts" },
  { kind: "transcript", heading: "Transcripts" },
];

const pageOf = (to: Addresses, result: SearchResult): string => {
  const slug = { slug: result.slug ?? result.id };
  switch (result.kind) {
    case "ticket":
      return to.ticket({ key: result.ticketKey ?? "" });
    case "document":
    case "report":
      return to.document(slug);
    case "term":
      return to.term({ id: result.id, projectId: result.projectId, name: result.title });
    case "decision":
      return to.decision({ id: result.id, projectId: result.projectId, number: result.number ?? 0 });
    case "artifact":
      return to.artifact(slug);
    case "transcript":
      return to.transcript(slug);
  }
};

/** A search's results across the Workspace, or one Project, grouped by kind, each with where it matched. */
export function SearchScreen({ workspace }: { workspace: Workspace }) {
  usePlace(null);
  const to = useAddresses();
  const query = useQuery();
  const q = query.get("q") ?? "";
  const project = query.get("project") ?? "";
  const archived = query.get("archived") === "include";
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();

  useEffect(() => {
    api.projects(workspace.id).then(setProjects, () => setProjects([]));
  }, [workspace.id]);
  useEffect(() => {
    setFailure(null);
    // Another search's results never stand under this one's head while it loads.
    setResults(null);
    if (!q.trim()) {
      setResults([]);
      return;
    }
    latest(
      api.search(workspace.id, { q, ...(project ? { project } : {}), ...(archived ? { includeArchived: "true" } : {}) }),
      setResults,
      (e) => setFailure(e.message),
    );
  }, [workspace.id, q, project, archived, latest]);

  const keyOf = new Map(projects.map((p) => [p.id, p.key]));
  return (
    <div className="page">
      <PageHead crumbs={[workspaceCrumb(workspace)]} title="Search" meta={q ? <>Results for “{q}”</> : undefined} />
      <div className="filters" role="group" aria-label="Filters">
        <label className="filter">
          <span className="sr-only">Project</span>
          <select value={project} onChange={(e) => navigate(searchPage(to, q, e.target.value || undefined, archived))}>
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => navigate(searchPage(to, q, project || undefined, e.target.checked))} />
          Include archived Tickets
        </label>
      </div>
      <FormError error={failure} />
      {results &&
        (results.length === 0 ? (
          <EmptyState title={q.trim() ? `Nothing matches ${q}.` : "Search the Workspace."}>
            Words match whatever their ending; put a phrase in quotes, write or between alternatives, and -word to
            leave out what has it.
          </EmptyState>
        ) : (
          <section aria-label="Search results" className="search-results">
            {groups.map(({ kind, heading }) => {
              const found = results.filter((r) => r.kind === kind);
              if (found.length === 0) return null;
              const id = `search-${kind}`;
              return (
                <section key={kind} aria-labelledby={id} className="search-group">
                  <h2 id={id}>
                    {heading} <span className="filter-count">{found.length}</span>
                  </h2>
                  <ul className="search-list">
                    {found.map((result) => (
                      <li key={result.id} className="search-result">
                        <Link to={pageOf(to, result)} className="search-title">
                          {result.ticketKey && <Key>{result.ticketKey}</Key>} {result.title}
                          {result.archived && <> <Chip>Archived</Chip></>}
                        </Link>
                        {result.projectId ? (
                          <span className="search-place">
                            <Key>{keyOf.get(result.projectId) ?? ""}</Key>
                          </span>
                        ) : (
                          <span className="search-place">Workspace</span>
                        )}
                        <p className="search-snippet">
                          {result.snippet.map((part, index) =>
                            part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
                          )}
                        </p>
                      </li>
                    ))}
                  </ul>
                  {found.length === perKind && (
                    <p className="muted search-more">The best {perKind} shown; narrow the search for others.</p>
                  )}
                </section>
              );
            })}
          </section>
        ))}
    </div>
  );
}
