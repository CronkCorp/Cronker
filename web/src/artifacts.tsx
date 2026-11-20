import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Artifact, type ArtifactComparison, type ComparedFile, type ProjectSummary, type VersionWithBody, type Workspace } from "./api.js";
import { sized } from "./attachments.js";
import { VersionMeta, Versions } from "./documents.js";
import { usePlace } from "./frame.js";
import { useLatest, useLiveEvents } from "./live.js";
import { buttonClass, FormError, LiveIndicator, PageHead, Panel, workspaceCrumb } from "./ui/controls.js";
import { Diff } from "./ui/diff.js";
import { Chip, type Tone } from "./ui/labels.js";

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
          <Versions<VersionWithBody, ArtifactComparison>
            key={artifact.version.number}
            source={{
              list: () => api.artifactVersions(artifact.id),
              compare: (from, to) => api.compareArtifactVersions(artifact.id, from, to),
              showComparison: (comparison) => <ComparedFiles comparison={comparison} />,
            }}
          />
        </aside>
      </div>
    </div>
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
          <FileCompared file={file} from={from.number} to={to.number} />
        </section>
      ))}
    </div>
  );
}

/** A file's Diff, or what to say instead where a Diff would show nothing. */
function FileCompared({ file, from, to }: { file: ComparedFile; from: number; to: number }) {
  if (!file.text) return <p className="muted small">Not text, so not compared line by line.</p>;
  if (file.lines.length === 0) return <p className="muted small">Empty file.</p>;
  if (file.lines.every((line) => line.change === "same")) return <p className="muted small">Only its line endings changed.</p>;
  return <Diff from={`Version ${from}`} to={`Version ${to}`} lines={file.lines} label={`${file.path} compared`} />;
}
