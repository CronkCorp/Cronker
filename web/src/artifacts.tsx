import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Artifact, type ProjectSummary, type Workspace } from "./api.js";
import { VersionMeta } from "./documents.js";
import { usePlace } from "./frame.js";
import { useLatest, useLiveEvents } from "./live.js";
import { buttonClass, FormError, LiveIndicator, PageHead, Panel, workspaceCrumb } from "./ui/controls.js";

/** A size as people read it: bytes, KB or MB. */
function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}

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
                  <span className="muted artifact-file-size">{sizeOf(file.size)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </aside>
      </div>
    </div>
  );
}
