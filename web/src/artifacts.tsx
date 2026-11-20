import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Artifact, type ArtifactComparison, type ArtifactVersion, type ComparedFile, type ProjectSummary, type Workspace } from "./api.js";
import { sized } from "./attachments.js";
import { VersionMeta } from "./documents.js";
import { usePlace } from "./frame.js";
import { useLatest, useLiveEvents } from "./live.js";
import { Actor } from "./ui/actor.js";
import { buttonClass, FormError, LiveIndicator, PageHead, Panel, RelativeTime, workspaceCrumb } from "./ui/controls.js";
import { Diff } from "./ui/diff.js";
import { Chip, type Tone } from "./ui/labels.js";
import { Dialog } from "./ui/overlays.js";

/**
 * An Artifact's page: the Artifact itself in an iframe sandboxed as its address serves it, scripts allowed and its
 * origin opaque, so it never acts as the signed-in User (ADR 0004); with its files beside it.
 */
export function ArtifactScreen({
  workspace,
  artifactId,
  onOtherWorkspace,
}: {
  workspace: Workspace;
  artifactId: string;
  /** Offered an Artifact of another Workspace; returns whether the screen switches to that Workspace. */
  onOtherWorkspace?: (workspaceId: string) => boolean;
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;
  usePlace(null, artifact?.projectId ?? null);

  useEffect(() => {
    api.artifact(artifactId).then(
      (found) => {
        if (found.workspaceId === workspace.id) setArtifact(found);
        else if (!otherWorkspace.current?.(found.workspaceId)) setFailure("No such Artifact.");
      },
      (e: Error) => setFailure(e.message),
    );
  }, [artifactId, workspace.id]);
  const latest = useLatest();
  const reload = useCallback(() => latest(api.artifact(artifactId), setArtifact), [artifactId, latest]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "artifact.changed" && event.artifactId === artifactId)) reload();
  });
  const projectId = artifact?.projectId ?? null;
  useEffect(() => {
    if (projectId) api.project(projectId).then(setProject, () => setProject(null));
  }, [projectId]);

  if (failure) return <FormError error={failure} />;
  if (!artifact) return <p className="muted">Loading…</p>;
  const crumbs = [
    workspaceCrumb(workspace),
    ...(project ? [{ label: <span className="mono">{project.key}</span>, to: `/projects/${project.id}` }] : []),
  ];
  return (
    <div className="page">
      <PageHead
        crumbs={crumbs}
        title={artifact.title}
        large
        switcher={<LiveIndicator workspaceId={workspace.id} />}
        meta={<VersionMeta version={artifact.version} />}
        actions={
          <a className={buttonClass()} href={artifact.url} target="_blank" rel="noopener noreferrer">
            Open
          </a>
        }
      />
      {artifact.description && <p className="artifact-description">{artifact.description}</p>}
      <div className="page-split">
        {/* Each Version has its own address, so a save shows afresh. */}
        <iframe
          key={artifact.url}
          className="artifact-frame"
          title={artifact.title}
          src={artifact.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
        <aside className="side">
          <Panel title="Files" className="panel-flush">
            <ul className="artifact-files">
              {artifact.files.map((file) => (
                <li key={file.path}>
                  <span className="mono">{file.path}</span>
                  {file.path === artifact.page && <span className="muted"> · page</span>}
                  <span className="muted artifact-file-size">{sized(file.size)}</span>
                </li>
              ))}
            </ul>
          </Panel>
          {/* A new Version remounts the list, so it reads afresh. */}
          <ArtifactVersions key={artifact.version.number} artifactId={artifact.id} />
        </aside>
      </div>
    </div>
  );
}

/** An Artifact's Versions, newest first, each with who saved it and when: pick two to see what changed, file by file. */
function ArtifactVersions({ artifactId }: { artifactId: string }) {
  const [versions, setVersions] = useState<ArtifactVersion[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [comparison, setComparison] = useState<ArtifactComparison | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    api.artifactVersions(artifactId).then(setVersions, (e: Error) => setFailure(e.message));
  }, [artifactId]);

  const pick = (number: number, on: boolean) => {
    const next = on ? [...picked.filter((n) => n !== number), number].slice(-2) : picked.filter((n) => n !== number);
    setPicked(next);
    if (next.length === 2) {
      api.compareArtifactVersions(artifactId, Math.min(...next), Math.max(...next)).then(setComparison, (e: Error) => setFailure(e.message));
    }
  };

  if (!versions) return failure ? <FormError error={failure} /> : null;
  return (
    <section aria-label="Versions" className="panel side-section">
      <h2 className="side-title">Versions</h2>
      {versions.length > 1 && <p className="muted small">Pick two to see what changed.</p>}
      <ol className="version-list">
        {[...versions].reverse().map((version) => (
          <li key={version.number}>
            {versions.length > 1 && (
              <input
                type="checkbox"
                aria-label={`Compare Version ${version.number}`}
                checked={picked.includes(version.number)}
                onChange={(e) => pick(version.number, e.target.checked)}
              />
            )}
            <span className="version-item">
              <span>Version {version.number}</span>
              <span className="version-by">
                <Actor actor={version.actor} /> <RelativeTime at={version.savedAt} />
              </span>
            </span>
          </li>
        ))}
      </ol>
      <FormError error={failure} />
      <Dialog
        open={comparison !== null}
        onOpenChange={(open) => {
          if (!open) {
            setComparison(null);
            setPicked([]);
          }
        }}
        title="What changed"
        wide
      >
        {comparison && <ComparedFiles comparison={comparison} />}
      </Dialog>
    </section>
  );
}

const changeShown: Record<ComparedFile["change"], { label: string; tone: Tone }> = {
  added: { label: "Added", tone: "ok" },
  removed: { label: "Removed", tone: "warn" },
  changed: { label: "Changed", tone: "neutral" },
};

/** Each file that differs between two Versions, by path: whether it was added, removed or changed, and its Diff. */
function ComparedFiles({ comparison }: { comparison: ArtifactComparison }) {
  const { from, to, files } = comparison;
  if (files.length === 0) return <p className="muted">No file changed between Version {from.number} and Version {to.number}.</p>;
  return (
    <div className="compared-files">
      {files.map((file) => (
        <section key={file.path} aria-label={file.path} className="compared-file">
          <h3 className="compared-file-head">
            <span className="mono">{file.path}</span>
            <Chip tone={changeShown[file.change].tone}>{changeShown[file.change].label}</Chip>
          </h3>
          {file.text ? (
            <Diff from={`Version ${from.number}`} to={`Version ${to.number}`} lines={file.lines} label={`${file.path} compared`} />
          ) : (
            <p className="muted small">Not text, so not compared line by line.</p>
          )}
        </section>
      ))}
    </div>
  );
}
