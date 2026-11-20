import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Artifact, type ArtifactComparison, type ArtifactSummary, type ComparedFile, type Place, type ProjectSummary, type VersionWithBody, type Workspace } from "./api.js";
import { sized } from "./attachments.js";
import { VersionMeta, Versions } from "./documents.js";
import { usePlace } from "./frame.js";
import { useArrivals, useDeletedElsewhere, useLatest, useLiveEvents } from "./live.js";
import { knowledgeCrumbs, ScopeSwitch } from "./projects.js";
import { Link, navigate } from "./router.js";
import { Actor } from "./ui/actor.js";
import {
  buttonClass,
  DeletedElsewhere,
  EmptyState,
  FormError,
  LiveIndicator,
  PageHead,
  Panel,
  RelativeTime,
  workspaceCrumb,
} from "./ui/controls.js";
import { Diff } from "./ui/diff.js";
import { Chip, type Tone } from "./ui/labels.js";
import { ConfirmDialog, Menu, MenuItem } from "./ui/overlays.js";

/** Where a Project's or the Workspace's Artifacts are listed. */
const listPage = (place: Place) => (place.kind === "project" ? `/projects/${place.id}/artifacts` : `/workspaces/${place.id}/artifacts`);

/** A Project's Artifacts, or the Workspace's own, last changed first. */
function ArtifactList({ workspace, project }: { workspace: Workspace; project: ProjectSummary | null }) {
  const place: Place = project ? { kind: "project", id: project.id } : { kind: "workspace", id: workspace.id };
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const load = useCallback(
    () => latest(api.artifacts(place), setArtifacts, (e) => setFailure(e.message)),
    [place.kind, place.id, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "artifact.changed" && event.projectId === (project?.id ?? null))) load();
  });
  const arrived = useArrivals(artifacts?.map((a) => a.id) ?? [], artifacts !== null);

  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, "Artifacts")}
        title="Artifacts"
        switcher={
          <>
            <LiveIndicator workspaceId={workspace.id} />
            <ScopeSwitch workspace={workspace} project={project} kind="artifacts" />
          </>
        }
      />
      <FormError error={failure} />
      {artifacts &&
        (artifacts.length === 0 ? (
          <EmptyState title="No Artifacts yet.">
            Agents and Users create them over the API and MCP; one an Agent makes during a Run is linked to its Ticket.
          </EmptyState>
        ) : (
          <section aria-label="Artifacts" className="panel panel-flush">
            <table className="register artifact-list">
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Saved by</th>
                  <th>Changed</th>
                </tr>
              </thead>
              <tbody>
                {artifacts.map((artifact) => (
                  <tr key={artifact.id} className={arrived.has(artifact.id) ? "arrived" : undefined}>
                    <td>
                      <Link to={`/artifacts/${artifact.id}`}>{artifact.title}</Link>
                      {artifact.description && <p className="artifact-list-description">{artifact.description}</p>}
                    </td>
                    <td>
                      <Actor actor={artifact.version.actor} />
                    </td>
                    <td>
                      <RelativeTime at={artifact.version.savedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
    </div>
  );
}

/** The Workspace's own Artifacts, separate from its Projects'. */
export function WorkspaceArtifacts({ workspace }: { workspace: Workspace }) {
  usePlace("artifacts");
  return <ArtifactList workspace={workspace} project={null} />;
}

/** A Project's Artifacts. */
export function ProjectArtifacts({ workspace, project }: { workspace: Workspace; project: ProjectSummary }) {
  usePlace("artifacts", project.id);
  return <ArtifactList workspace={workspace} project={project} />;
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
  const [deleting, setDeleting] = useState(false);
  const { gone, failed, deleteHere } = useDeletedElsewhere();
  const otherWorkspace = useRef(onOtherWorkspace);
  otherWorkspace.current = onOtherWorkspace;
  usePlace("artifacts", artifact?.projectId ?? null);

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
  /** Fetches the shown Artifact again after a live event, keeping it on screen if it went meanwhile. */
  const reload = useCallback(() => latest(api.artifact(artifactId), setArtifact, failed), [artifactId, latest, failed]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "artifact.changed" && event.artifactId === artifactId)) reload();
  });
  const projectId = artifact?.projectId ?? null;
  useEffect(() => {
    if (projectId) api.project(projectId).then(setProject, () => setProject(null));
  }, [projectId]);

  if (failure) return <FormError error={failure} />;
  if (!artifact) return <p className="muted">Loading…</p>;
  const list = listPage(artifact.projectId ? { kind: "project", id: artifact.projectId } : { kind: "workspace", id: artifact.workspaceId });
  const crumbs = [
    workspaceCrumb(workspace),
    ...(project ? [{ label: <span className="mono">{project.key}</span>, to: `/projects/${project.id}` }] : []),
    { label: "Artifacts", to: list },
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
          !gone && (
            <>
              <Menu label="More of this Artifact">
                <MenuItem tone="danger" onSelect={() => setDeleting(true)}>
                  Delete Artifact
                </MenuItem>
              </Menu>
              <a className={buttonClass()} href={artifact.url} target="_blank" rel="noopener noreferrer">
                Open
              </a>
            </>
          )
        }
      />
      {gone && <DeletedElsewhere back={{ to: list, label: "Back to Artifacts" }}>this Artifact is no longer kept.</DeletedElsewhere>}
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
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${artifact.title}?`}
        confirm="Delete"
        onConfirm={async () => {
          await deleteHere(() => api.deleteArtifact(artifact.id));
          navigate(list);
        }}
      >
        It goes with all its Versions and their files, and the Tickets linking it lose the link. It can't be brought back.
      </ConfirmDialog>
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
