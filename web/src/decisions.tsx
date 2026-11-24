import { useActiveProject, useAddresses } from "./addresses.js";
import { useCallback, useEffect, useState } from "react";
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
import { knowledgeCrumbs } from "./projects.js";
import { KnowledgeSection } from "./knowledge-section.js";
import { Link, navigate } from "./router.js";
import { Actor } from "./ui/actor.js";
import { useArrivals, useLatest, useLiveEvents } from "./live.js";
import { Banner, Button, EmptyState, Field, FormError, LiveIndicator, PageHead, Panel, RelativeTime, Saved } from "./ui/controls.js";
import { DecisionStatusPill, decisionStatusLabel } from "./ui/labels.js";
import { ProjectNote } from "./write-access.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose, Menu, MenuItem } from "./ui/overlays.js";
import { MentionedIn } from "./mentioned-in.js";

/** A Decision's number as it is written, such as 0007. */
const numbered = (number: number) => String(number).padStart(4, "0");

/** A register's Decisions as loaded, kept current as they change. */
interface Register {
  place: Place;
  project: ProjectSummary | null;
  decisions: DecisionSummary[] | null;
  failure: string | null;
  load: () => void;
  replace: (next: DecisionSummary) => void;
}

/** Loads a Project's register, or the Workspace's own, and loads it again as its Decisions change. */
function useRegister(workspace: Workspace, project: ProjectSummary | null): Register {
  const place: Place = project ? { kind: "project", id: project.id } : { kind: "workspace", id: workspace.id };
  const [decisions, setDecisions] = useState<DecisionSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const load = useCallback(
    () => latest(api.decisions(place), setDecisions, (e) => setFailure(e.message)),
    [place.kind, place.id, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "decision.changed" && event.projectId === (project?.id ?? null))) load();
  });
  const replace = useCallback(
    (next: DecisionSummary) => setDecisions((all) => all?.map((d) => (d.id === next.id ? next : d)) ?? null),
    [],
  );
  return { place, project, decisions, failure, load, replace };
}

/**
 * The Decisions page: the status filter chips in its head, which filter and count every register shown, then each
 * register as its own section, the Project's before the Workspace's.
 */
function DecisionsPage({ workspace, project, registers }: { workspace: Workspace; project: ProjectSummary | null; registers: Register[] }) {
  const [only, setOnly] = useState<DecisionStatus | null>(null);
  const all = registers.flatMap((r) => r.decisions ?? []);
  const count = (status: DecisionStatus) => all.filter((d) => d.status === status).length;
  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, "Decisions")}
        title="Decisions"
        switcher={<LiveIndicator workspaceId={workspace.id} />}
      />
      {all.length > 0 && (
        <div className="filter-chips" role="group" aria-label="Filter by status">
          <button type="button" className="filter-chip" aria-pressed={only === null} onClick={() => setOnly(null)}>
            All <span className="filter-count">{all.length}</span>
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
      )}
      {registers.map((register) => (
        <RegisterSection key={register.place.id} register={register} only={only} />
      ))}
    </div>
  );
}

/** One register as a section: its heading, Export and New Decision, then its table of Decisions or its empty state. */
function RegisterSection({ register, only }: { register: Register; only: DecisionStatus | null }) {
  const to = useAddresses();
  const { place, project, decisions, failure, load, replace } = register;
  const [creating, setCreating] = useState(false);
  const arrived = useArrivals(decisions?.map((d) => d.id) ?? [], decisions !== null);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createDecision(place, { title: field(form, "title") });
    navigate(to.decision(created));
  });

  // With Read in the Project, its register offers no New Decision, Accept or Reject; the Workspace's stays Write.
  const canWrite = !project || project.access === "write";
  const shown = decisions?.filter((d) => only === null || d.status === only) ?? [];
  return (
    <KnowledgeSection
      project={project}
      actions={
        <>
          <ExportLink place={place} />
          {canWrite && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New Decision
            </Button>
          )}
        </>
      }
    >
      {project && <ProjectNote project={project} />}
      <FormError error={failure} />
      {decisions &&
        (decisions.length === 0 ? (
          <EmptyState title="No Decisions yet.">
            {canWrite ? "New Decision records one: what was decided and why, proposed until accepted." : null}
          </EmptyState>
        ) : shown.length === 0 ? (
          <p className="muted">None {only ? decisionStatusLabel(only).toLowerCase() : ""} here.</p>
        ) : (
          <div className="panel panel-flush">
            <table className="register">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Changed</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((decision) => {
                  const replacement = decisions.find((d) => d.id === decision.supersededById);
                  return (
                    <tr key={decision.id} className={arrived.has(decision.id) ? "arrived" : undefined}>
                      <td className="mono muted">{numbered(decision.number)}</td>
                      <td>
                        <Link to={to.decision(decision)}>{decision.title}</Link>
                        {replacement && (
                          <>
                            {" "}
                            <Link to={to.decision(replacement)} className="superseded-by" title={`Superseded by ${replacement.title}`}>
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
                      <td className="register-actions">
                        {canWrite && <RowActions decision={decision} onChanged={replace} onOutdated={load} />}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
    </KnowledgeSection>
  );
}

/** The Workspace's own Decisions, separate from its Projects': its register alone. */
export function WorkspaceDecisions({ workspace }: { workspace: Workspace }) {
  usePlace("decisions");
  const register = useRegister(workspace, null);
  return <DecisionsPage workspace={workspace} project={null} registers={[register]} />;
}

/** A Project's Decisions: its register, then the Workspace's. */
export function ProjectDecisions({ workspace, project }: { workspace: Workspace; project: ProjectSummary }) {
  usePlace("decisions", project.id);
  const own = useRegister(workspace, project);
  const workspaces = useRegister(workspace, null);
  return <DecisionsPage workspace={workspace} project={project} registers={[own, workspaces]} />;
}

/** A Decision: read it, edit its text as Markdown with a preview, change its status, and browse its Versions. */
export function DecisionScreen({
  workspace,
  decisionId,
}: {
  workspace: Workspace;
  decisionId: string;
}) {
  const to = useAddresses();
  const activeProject = useActiveProject();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [others, setOthers] = useState<DecisionSummary[]>([]);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [first, setFirst] = useState<DecisionVersion | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [versionsShown, setVersionsShown] = useState(0);
  usePlace("decisions", decision?.projectId ?? null);

  const load = useCallback(() => {
    api.decision(decisionId).then(
      (found) => {
        if (found.workspaceId === workspace.id) setDecision(found);
        else setFailure("No such Decision.");
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
  const status = useStatusChange({
    onChanged: saved,
    onOutdated: () => {
      load();
      setVersionsShown((n) => n + 1);
    },
    afterOutdated: "It now shows the current Version: check it, then change the status again.",
  });
  const [rejecting, setRejecting] = useState(false);
  const [superseding, setSuperseding] = useState(false);

  if (failure) return <FormError error={failure} />;
  if (!decision || !place) return <p className="muted">Loading…</p>;
  const replacement = others.find((d) => d.id === decision.supersededById);
  const replaced = others.filter((d) => d.supersededById === decision.id);
  // With Read in its Project, the Decision is only read: no Edit, and no change of status.
  const canWrite = !project || project.access === "write";
  // A Workspace Decision's list is the active Project's page, which shows the Workspace's register too.
  const listOf = (at: Place) =>
    at.kind === "workspace" && activeProject ? to.knowledge(activeProject, "decisions") : to.place(at, "decisions");
  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, <Link to={listOf(place)}>Decisions</Link>)}
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
          !editing &&
          canWrite && (
            <>
              <Saved shown={status.said(decision) !== null}>{status.said(decision)}</Saved>
              {menuChanges[decision.status].length > 0 && (
                <Menu label="More of this Decision">
                  {menuChanges[decision.status].map((to) =>
                    to === "superseded" ? (
                      <MenuItem key={to} disabled={status.busy} onSelect={() => setSuperseding(true)}>
                        Supersede…
                      </MenuItem>
                    ) : (
                      <MenuItem key={to} disabled={status.busy} onSelect={() => status.change(decision, to)}>
                        {to === "proposed" ? "Back to proposed" : "Deprecate"}
                      </MenuItem>
                    ),
                  )}
                </Menu>
              )}
              <Button
                variant={decision.status === "proposed" ? "secondary" : "primary"}
                onClick={() => {
                  status.clearError();
                  setEditing(true);
                }}
              >
                Edit
              </Button>
              {decision.status === "proposed" && (
                <>
                  <Button disabled={status.busy} onClick={() => setRejecting(true)}>
                    Reject
                  </Button>
                  <Button variant="primary" disabled={status.busy} onClick={() => status.change(decision, "accepted")}>
                    Accept
                  </Button>
                </>
              )}
            </>
          )
        }
      />
      {project && <ProjectNote project={project} />}
      {!editing && <FormError error={status.error} />}
      <RejectDialog
        decision={decision}
        // Closed once it is no longer proposed, as when someone else changed it meanwhile.
        open={rejecting && decision.status === "proposed"}
        onOpenChange={setRejecting}
        onReject={() => status.change(decision, "rejected")}
      />
      <Dialog
        open={superseding}
        onOpenChange={setSuperseding}
        title={`Supersede ${numbered(decision.number)} ${decision.title}`}
        description="Name the Decision that replaces it. This one stays in the register as Superseded, pointing at it."
      >
        <SupersedeForm
          decision={decision}
          others={others.filter((d) => d.id !== decision.id)}
          onSupersede={(replacement) => {
            setSuperseding(false);
            status.change(decision, "superseded", replacement);
          }}
        />
      </Dialog>
      {decision.supersededById && (
        <Banner tone="warn" label="Superseded">
          <p>
            Superseded by{" "}
            <Link to={replacement ? to.decision(replacement) : `/decisions/${decision.supersededById}`}>
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
                <Link to={to.decision(d)}>
                  {numbered(d.number)} {d.title}
                </Link>
                {index < replaced.length - 1 && ", "}
              </span>
            ))}
            .
          </p>
        </Banner>
      )}
      {editing && canWrite ? (
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
            mentions={decision.mentions}
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
            </Panel>
            <MentionedIn texts={decision.mentionedIn} />
            <Versions
              key={versionsShown}
              current={decision.version.number}
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

/** What a page or row says once a status change of its own is saved. */
const statusSaid: Record<DecisionStatus, string> = {
  proposed: "Back to proposed.",
  accepted: "Accepted.",
  rejected: "Rejected.",
  deprecated: "Deprecated.",
  superseded: "Superseded.",
};

/**
 * The status changes a Decision page's "…" menu offers, by its status; superseding asks for the replacing Decision
 * first. A proposed Decision is accepted or rejected with the buttons beside it instead.
 */
const menuChanges: Record<DecisionStatus, DecisionStatus[]> = {
  proposed: [],
  accepted: ["deprecated", "superseded"],
  rejected: ["proposed"],
  deprecated: ["proposed"],
  superseded: ["proposed", "superseded"],
};

/**
 * Saves a Decision's status at once from the Version shown, naming the Decision replacing it when superseded, and
 * keeps what it last said: "Accepted." while that Version is still the one shown, or why it was refused. A save based
 * on an outdated Version is refused: `onOutdated` shows the current one, and the refusal ends with `afterOutdated`.
 */
function useStatusChange({
  onChanged,
  onOutdated,
  afterOutdated,
}: {
  onChanged: (next: Decision) => void;
  onOutdated: () => void;
  afterOutdated: string;
}) {
  const [said, setSaid] = useState<{ text: string; decisionId: string; version: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async (decision: DecisionSummary, status: DecisionStatus, supersededById?: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.editDecision(decision.id, {
        baseVersion: decision.version.number,
        status,
        ...(status === "superseded" ? { supersededById: supersededById ?? null } : {}),
      });
      onChanged(next);
      setSaid({ text: statusSaid[status], decisionId: next.id, version: next.version.number });
    } catch (e) {
      if (e instanceof ApiError && e.code === "outdated_version") {
        onOutdated();
        setError(`${e.message} ${afterOutdated}`);
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    error,
    clearError: () => setError(null),
    change,
    /** What its last change of this Decision said, while the Version it saved is still the one shown. */
    said: (decision: DecisionSummary) =>
      said?.decisionId === decision.id && said.version === decision.version.number ? said.text : null,
  };
}

/** Asks before rejecting a proposed Decision, naming it: a rejected Decision is never deleted. */
function RejectDialog({
  decision,
  open,
  onOpenChange,
  onReject,
}: {
  decision: DecisionSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReject: () => Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Reject ${numbered(decision.number)} ${decision.title}?`}
      confirm="Reject"
      onConfirm={onReject}
    >
      A rejected Decision is never deleted: it stays in the register as Rejected, and a User can put it back to proposed.
    </ConfirmDialog>
  );
}

/**
 * Accept and Reject on a proposed Decision's row of the register, which save at once as on its page; the row says
 * what was saved, or why it was refused, in their place.
 */
function RowActions({
  decision,
  onChanged,
  onOutdated,
}: {
  decision: DecisionSummary;
  onChanged: (next: Decision) => void;
  /** Someone saved the Decision since the register was loaded; the register loads again. */
  onOutdated: () => void;
}) {
  const status = useStatusChange({
    onChanged,
    onOutdated,
    afterOutdated: "The register now shows it as it stands: check it, then change the status again.",
  });
  const [rejecting, setRejecting] = useState(false);
  const said = status.said(decision);
  return (
    <>
      {decision.status === "proposed" && (
        <>
          <Button variant="ghost" size="small" disabled={status.busy} onClick={() => setRejecting(true)}>
            Reject
          </Button>
          <Button size="small" disabled={status.busy} onClick={() => status.change(decision, "accepted")}>
            Accept
          </Button>
          <RejectDialog
            decision={decision}
            open={rejecting}
            onOpenChange={setRejecting}
            onReject={() => status.change(decision, "rejected")}
          />
        </>
      )}
      <Saved shown={said !== null}>{said}</Saved>
      <FormError error={status.error} />
    </>
  );
}

/** Names the Decision of the same place that replaces this one, and supersedes it. */
function SupersedeForm({
  decision,
  others,
  onSupersede,
}: {
  decision: Decision;
  /** The other Decisions of its Project, or of the Workspace's own. */
  others: DecisionSummary[];
  onSupersede: (replacement: string) => void;
}) {
  // Held here, not left to the picker, so it shows the Decision replacing this one even when the list arrives later.
  const [replacement, setReplacement] = useState(decision.supersededById ?? "");
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSupersede(replacement);
      }}
    >
      <Field label="Replaced by">
        <select required value={replacement} onChange={(e) => setReplacement(e.target.value)} autoFocus>
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
      <DialogActions>
        <DialogClose asChild>
          <Button>Cancel</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={replacement === decision.supersededById}>
          Supersede
        </Button>
      </DialogActions>
    </form>
  );
}
