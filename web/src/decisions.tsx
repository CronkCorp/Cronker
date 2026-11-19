import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type Decision,
  type DecisionStatus,
  decisionStatuses,
  type DecisionSummary,
  type DecisionVersion,
  type Place,
  type ProjectSummary,
  type Workspace,
} from "./api.js";
import { DocumentBody, Editor, VersionMeta, Versions } from "./documents.js";
import { ExportLink } from "./export.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { knowledgeCrumbs, ScopeSwitch } from "./projects.js";
import { Link, navigate } from "./router.js";
import { Actor } from "./ui/actor.js";
import { useArrivals, useLatest, useLiveEvents } from "./live.js";
import { Actions, Banner, Button, EmptyState, Field, FormError, LiveIndicator, PageHead, Panel, RelativeTime } from "./ui/controls.js";
import { DecisionStatusPill, decisionStatusLabel } from "./ui/labels.js";
import { Dialog, DialogActions, DialogClose } from "./ui/overlays.js";

/** A Decision's number as it is written, such as 0007. */
const numbered = (number: number) => String(number).padStart(4, "0");

/** Where a Project's or the Workspace's Decisions are listed. */
const listPage = (place: Place) => (place.kind === "project" ? `/projects/${place.id}/decisions` : `/workspaces/${place.id}/decisions`);

/** A Project's Decisions, or the Workspace's own: a register with status filters, and New Decision. */
function Register({ workspace, project }: { workspace: Workspace; project: ProjectSummary | null }) {
  const place: Place = project ? { kind: "project", id: project.id } : { kind: "workspace", id: workspace.id };
  const [decisions, setDecisions] = useState<DecisionSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [only, setOnly] = useState<DecisionStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const latest = useLatest();
  const load = useCallback(
    () => latest(api.decisions(place), setDecisions, (e) => setFailure(e.message)),
    [place.kind, place.id, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "decision.changed" && event.projectId === (project?.id ?? null))) load();
  });
  const arrived = useArrivals(decisions?.map((d) => d.id) ?? [], decisions !== null);

  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createDecision(place, { title: field(form, "title") });
    navigate(`/decisions/${created.id}`);
  });

  const count = (status: DecisionStatus) => decisions?.filter((d) => d.status === status).length ?? 0;
  const shown = decisions?.filter((d) => only === null || d.status === only) ?? [];
  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, "Decisions")}
        title="Decisions"
        switcher={
          <>
            <LiveIndicator workspaceId={workspace.id} />
            <ScopeSwitch workspace={workspace} project={project} kind="decisions" />
          </>
        }
        actions={
          <>
            <ExportLink place={place} />
            <Button variant="primary" onClick={() => setCreating(true)}>
              New Decision
            </Button>
          </>
        }
      />
      <FormError error={failure} />
      {decisions &&
        (decisions.length === 0 ? (
          <EmptyState title="No Decisions yet.">New Decision records one: what was decided and why, proposed until accepted.</EmptyState>
        ) : (
          <>
            <div className="filter-chips" role="group" aria-label="Filter by status">
              <button type="button" className="filter-chip" aria-pressed={only === null} onClick={() => setOnly(null)}>
                All <span className="filter-count">{decisions.length}</span>
              </button>
              {decisionStatuses.map((status) => (
                <button
                  key={status}
                  type="button"
                  className="filter-chip"
                  aria-pressed={only === status}
                  disabled={count(status) === 0}
                  onClick={() => setOnly(only === status ? null : status)}
                >
                  {decisionStatusLabel(status)} <span className="filter-count">{count(status)}</span>
                </button>
              ))}
            </div>
            <section aria-label="Decisions" className="panel panel-flush">
              <table className="register">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Title</th>
                    <th>Status</th>
                    <th>Changed</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((decision) => {
                    const replacement = decisions.find((d) => d.id === decision.supersededById);
                    return (
                      <tr key={decision.id} className={arrived.has(decision.id) ? "arrived" : undefined}>
                        <td className="mono muted">{numbered(decision.number)}</td>
                        <td>
                          <Link to={`/decisions/${decision.id}`}>{decision.title}</Link>
                          {replacement && (
                            <>
                              {" "}
                              <Link to={`/decisions/${replacement.id}`} className="superseded-by" title={`Superseded by ${replacement.title}`}>
                                → {numbered(replacement.number)}
                              </Link>
                            </>
                          )}
                        </td>
                        <td>
                          <DecisionStatusPill status={decision.status} />
                        </td>
                        <td>
                          <RelativeTime at={decision.version.savedAt} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          </>
        ))}
      <Dialog open={creating} onOpenChange={setCreating} title="New Decision" description="It starts as Proposed.">
        <form onSubmit={onSubmit}>
          <Field label="Title">
            <input name="title" required maxLength={300} autoFocus />
          </Field>
          <FormError error={error} />
          <DialogActions>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>
              Record Decision
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </div>
  );
}

/** The Workspace's own Decisions, separate from its Projects'. */
export function WorkspaceDecisions({ workspace }: { workspace: Workspace }) {
  usePlace("decisions");
  return <Register workspace={workspace} project={null} />;
}

/** A Project's Decisions. */
export function ProjectDecisions({ workspace, project }: { workspace: Workspace; project: ProjectSummary }) {
  usePlace("decisions", project.id);
  return <Register workspace={workspace} project={project} />;
}

/** A Decision: read it, edit its text as Markdown with a preview, change its status, and browse its Versions. */
export function DecisionScreen({
  workspace,
  decisionId,
  onOtherWorkspace,
}: {
  workspace: Workspace;
  decisionId: string;
  /** Offered a Decision of another Workspace; returns whether the screen switches to that Workspace. */
  onOtherWorkspace?: (workspaceId: string) => boolean;
}) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [others, setOthers] = useState<DecisionSummary[]>([]);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [first, setFirst] = useState<DecisionVersion | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [versionsShown, setVersionsShown] = useState(0);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;
  usePlace("decisions", decision?.projectId ?? null);

  const load = useCallback(() => {
    api.decision(decisionId).then(
      (found) => {
        if (found.workspaceId === workspace.id) setDecision(found);
        else if (!otherWorkspace.current?.(found.workspaceId)) setFailure("No such Decision.");
      },
      (e: Error) => setFailure(e.message),
    );
    // Who proposed it: whoever saved its first Version.
    api.decisionVersions(decisionId).then((versions) => setFirst(versions[0] ?? null), () => {});
  }, [decisionId, workspace.id]);
  useEffect(load, [load]);

  const place: Place | null = decision
    ? decision.projectId
      ? { kind: "project", id: decision.projectId }
      : { kind: "workspace", id: decision.workspaceId }
    : null;
  const latestOthers = useLatest();
  const loadOthers = useCallback(() => {
    if (place) latestOthers(api.decisions(place), setOthers, () => setOthers([]));
  }, [place?.kind, place?.id, latestOthers]);
  // Its own save may supersede it by another, which the banner names; it shows even while the stream is away.
  useEffect(loadOthers, [loadOthers, decision?.version.number]);
  useEffect(() => {
    if (place?.kind === "project") api.project(place.id).then(setProject, () => setProject(null));
  }, [place?.kind, place?.id]);
  const latestDecision = useLatest();
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "decision.changed" && event.decisionId === decisionId)) {
      latestDecision(api.decision(decisionId), setDecision);
    }
    // Another Decision of its register may now supersede it, or be superseded by it.
    if (event.type === "reconnected" || (event.type === "decision.changed" && place && event.projectId === (place.kind === "project" ? place.id : null))) {
      loadOthers();
    }
  });

  const saved = (next: Decision) => {
    setDecision(next);
    setVersionsShown((n) => n + 1);
  };

  if (failure) return <FormError error={failure} />;
  if (!decision || !place) return <p className="muted">Loading…</p>;
  const replacement = others.find((d) => d.id === decision.supersededById);
  const replaced = others.filter((d) => d.supersededById === decision.id);
  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, <Link to={listPage(place)}>Decisions</Link>)}
        title={decision.title}
        large
        eyebrow={
          <>
            <span className="mono">{numbered(decision.number)}</span>
            <DecisionStatusPill status={decision.status} />
          </>
        }
        switcher={<LiveIndicator workspaceId={workspace.id} />}
        meta={<VersionMeta version={decision.version} />}
        actions={
          !editing && (
            <Button variant="primary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )
        }
      />
      {decision.supersededById && (
        <Banner tone="warn" label="Superseded">
          <p>
            Superseded by{" "}
            <Link to={`/decisions/${decision.supersededById}`}>
              {replacement ? `${numbered(replacement.number)} ${replacement.title}` : "the Decision replacing it"}
            </Link>
            .
          </p>
        </Banner>
      )}
      {replaced.length > 0 && (
        <Banner tone="info" label="Supersedes">
          <p>
            Supersedes{" "}
            {replaced.map((d, index) => (
              <span key={d.id}>
                <Link to={`/decisions/${d.id}`}>
                  {numbered(d.number)} {d.title}
                </Link>
                {index < replaced.length - 1 && ", "}
              </span>
            ))}
            .
          </p>
        </Banner>
      )}
      {editing ? (
        <Editor
          saved={decision}
          save={(edit) => api.editDecision(decision.id, edit)}
          onSaved={(next) => {
            saved(next);
            setEditing(false);
          }}
          onRebased={() => {
            load();
            setVersionsShown((n) => n + 1);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div className="page-split">
          <DocumentBody
            body={decision.body}
            label={decision.title}
            empty={<EmptyState title="Nothing written yet.">Edit records the context, the decision and what follows from it.</EmptyState>}
          />
          <aside className="side" aria-label="Decision details">
            <Panel className="side-section">
              <div className="side-row">
                <span className="field-row-label">Status</span>
                <DecisionStatusPill status={decision.status} />
              </div>
              {first && (
                <div className="side-row">
                  <span className="field-row-label">Proposed by</span>
                  <Actor actor={first.actor} />
                </div>
              )}
              <StatusForm
                key={decision.version.number}
                decision={decision}
                others={others.filter((d) => d.id !== decision.id)}
                onChanged={saved}
                onOutdated={() => {
                  load();
                  setVersionsShown((n) => n + 1);
                }}
              />
            </Panel>
            <Versions
              key={`${versionsShown} ${decision.version.number}`}
              source={{
                list: () => api.decisionVersions(decision.id),
                read: (number) => api.decisionVersion(decision.id, number),
                compare: (from, to) => api.compareDecisionVersions(decision.id, from, to),
              }}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

/** Changes the Decision's status, naming the Decision of the same place that replaces it when superseded. */
function StatusForm({
  decision,
  others,
  onChanged,
  onOutdated,
}: {
  decision: Decision;
  /** The other Decisions of its Project, or of the Workspace's own. */
  others: DecisionSummary[];
  onChanged: (next: Decision) => void;
  /** Someone saved the Decision since it was shown; the screen shows its current Version again. */
  onOutdated: () => void;
}) {
  const [status, setStatus] = useState<DecisionStatus>(decision.status);
  // Held here, not left to the picker, so it shows the Decision replacing this one even when the list arrives later.
  const [replacement, setReplacement] = useState(decision.supersededById ?? "");
  const unchanged = status === decision.status && (status !== "superseded" || replacement === decision.supersededById);
  const { error, busy, onSubmit } = useSubmit(async () => {
    try {
      onChanged(
        await api.editDecision(decision.id, {
          baseVersion: decision.version.number,
          status,
          ...(status === "superseded" ? { supersededById: replacement || null } : {}),
        }),
      );
    } catch (e) {
      if (e instanceof ApiError && e.code === "outdated_version") {
        onOutdated();
        throw new Error(`${e.message} It now shows the current Version: check it, then change the status again.`);
      }
      throw e;
    }
  });
  return (
    <form onSubmit={onSubmit}>
      <Field label="Change status">
        <select value={status} onChange={(e) => setStatus(e.target.value as DecisionStatus)}>
          {decisionStatuses.map((s) => (
            <option key={s} value={s}>
              {decisionStatusLabel(s)}
            </option>
          ))}
        </select>
      </Field>
      {status === "superseded" && (
        <Field label="Replaced by">
          <select required value={replacement} onChange={(e) => setReplacement(e.target.value)}>
            <option value="" disabled>
              Choose a Decision
            </option>
            {others.map((d) => (
              <option key={d.id} value={d.id}>
                {numbered(d.number)} {d.title}
              </option>
            ))}
          </select>
        </Field>
      )}
      <FormError error={error} />
      <Actions>
        <Button type="submit" disabled={busy || unchanged}>
          Save status
        </Button>
      </Actions>
    </form>
  );
}
