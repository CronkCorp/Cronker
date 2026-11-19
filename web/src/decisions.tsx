import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type Decision,
  type DecisionStatus,
  decisionStatuses,
  type DecisionSummary,
  type Place,
  type Workspace,
} from "./api.js";
import { Editor, versionLine, Versions } from "./documents.js";
import { ExportLink } from "./export.js";
import { field, useSubmit } from "./forms.js";
import { Markdown } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { Button } from "./button.js";

const statusLabel = (status: DecisionStatus) => status[0]!.toUpperCase() + status.slice(1);

/** Where a Project's or the Workspace's Decisions are listed: a Project's Decisions tab, or the Workspace's Decisions page. */
const listPage = (place: Place) => (place.kind === "project" ? `/projects/${place.id}/decisions` : `/workspaces/${place.id}/decisions`);

/** A Project's Decisions, or the Workspace's own, by number, and a form to record one. */
export function DecisionList({ place }: { place: Place }) {
  const [decisions, setDecisions] = useState<DecisionSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api.decisions(place).then(setDecisions, (e: Error) => setFailure(e.message));
  }, [place.kind, place.id]);

  const { error, busy, onSubmit } = useSubmit(async (form) => {
    const created = await api.createDecision(place, { title: field(form, "title") });
    navigate(`/decisions/${created.id}`);
  });

  if (failure) return <p role="alert">{failure}</p>;
  if (!decisions) return <p>Loading…</p>;
  return (
    <section aria-label="Decisions" className="decision-list">
      <ExportLink place={place} />
      {decisions.length === 0 ? (
        <p>No Decisions yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Number</th>
              <th>Title</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((decision) => (
              <tr key={decision.id}>
                <td>{decision.number}</td>
                <td>
                  <Link to={`/decisions/${decision.id}`}>{decision.title}</Link>
                </td>
                <td>{statusLabel(decision.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={onSubmit} className="inline">
        <label>
          New Decision title
          <input name="title" required maxLength={300} />
        </label>
        <Button variant="primary" type="submit" disabled={busy}>
          Record Decision
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** The Workspace's own Decisions, separate from its Projects'. */
export function WorkspaceDecisions({ workspace }: { workspace: Workspace }) {
  return (
    <>
      <h1>{workspace.name} Decisions</h1>
      <DecisionList place={{ kind: "workspace", id: workspace.id }} />
    </>
  );
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
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [versionsShown, setVersionsShown] = useState(0);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;

  const load = useCallback(() => {
    api.decision(decisionId).then(
      (found) => {
        if (found.workspaceId === workspace.id) setDecision(found);
        else if (!otherWorkspace.current?.(found.workspaceId)) setFailure("No such Decision.");
      },
      (e: Error) => setFailure(e.message),
    );
  }, [decisionId, workspace.id]);
  useEffect(load, [load]);

  const place: Place | null = decision
    ? decision.projectId
      ? { kind: "project", id: decision.projectId }
      : { kind: "workspace", id: decision.workspaceId }
    : null;
  useEffect(() => {
    if (place) api.decisions(place).then(setOthers, () => setOthers([]));
  }, [place?.kind, place?.id]);

  const saved = (next: Decision) => {
    setDecision(next);
    setVersionsShown((n) => n + 1);
  };

  if (failure) return <p role="alert">{failure}</p>;
  if (!decision || !place) return <p>Loading…</p>;
  const replacement = others.find((d) => d.id === decision.supersededById);
  return (
    <article className="decision">
      <p>
        <Link to={listPage(place)}>{place.kind === "project" ? "Project Decisions" : "Workspace Decisions"}</Link>
      </p>
      <h1 className="title">
        Decision {decision.number}: {decision.title}
      </h1>
      <p>
        <span className={`decision-status ${decision.status}`}>{statusLabel(decision.status)}</span>
        {decision.supersededById && (
          <>
            {" by "}
            <Link to={`/decisions/${decision.supersededById}`}>
              {replacement ? `Decision ${replacement.number}: ${replacement.title}` : "its replacing Decision"}
            </Link>
          </>
        )}
      </p>
      <p className="muted">{versionLine(decision.version)}</p>
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
        <>
          <div className="actions">
            <Button variant="secondary" type="button" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
          {decision.body.trim() ? <Markdown text={decision.body} mentions={[]} /> : <p className="muted">Empty.</p>}
          <StatusForm
            decision={decision}
            others={others.filter((d) => d.id !== decision.id)}
            onChanged={saved}
            onOutdated={() => {
              load();
              setVersionsShown((n) => n + 1);
            }}
          />
        </>
      )}
      <Versions
        key={versionsShown}
        source={{
          list: () => api.decisionVersions(decision.id),
          read: (number) => api.decisionVersion(decision.id, number),
          compare: (from, to) => api.compareDecisionVersions(decision.id, from, to),
        }}
      />
    </article>
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
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    try {
      onChanged(
        await api.editDecision(decision.id, {
          baseVersion: decision.version.number,
          status,
          ...(status === "superseded" ? { supersededById: field(form, "supersededById") || null } : {}),
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
    <>
      <form onSubmit={onSubmit} className="inline status-form" key={decision.version.number}>
        <label>
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as DecisionStatus)}>
            {decisionStatuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
        </label>
        {status === "superseded" && (
          <label>
            Replaced by
            <select name="supersededById" required defaultValue={decision.supersededById ?? ""}>
              <option value="" disabled>
                Choose a Decision
              </option>
              {others.map((d) => (
                <option key={d.id} value={d.id}>
                  Decision {d.number}: {d.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button variant="ghost" type="submit" disabled={busy}>
          Change status
        </Button>
      </form>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
