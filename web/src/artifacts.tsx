import { useAddresses, useCanonicalAddress } from "./addresses.js";
import { useCallback, useEffect, useState } from "react";
import { api, type Artifact, type ArtifactComparison, type ArtifactSummary, type Comment, type ComparedFile, type Place, type ProjectSummary, type User, type VersionWithBody, type Workspace } from "./api.js";
import { sized } from "./attachments.js";
import { VersionMeta, Versions } from "./documents.js";
import { usePlace } from "./frame.js";
import { useArrivals, useDeletedElsewhere, useLatest, useLiveEvents } from "./live.js";
import { knowledgeCrumbs } from "./projects.js";
import { KnowledgeSection } from "./knowledge-section.js";
import { ArtifactFrame } from "./embed.js";
import { Link, navigate, useQuery } from "./router.js";
import { Actor, Avatar } from "./ui/actor.js";
import {
  Banner,
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
import { ProjectAccessProvider, ProjectNote, useCanWrite } from "./write-access.js";
import { CommentsPanel, useComments } from "./comments-panel.js";
import { ConfirmDialog, Menu, MenuItem } from "./ui/overlays.js";

/** A Project's Artifacts, or the Workspace's own, as loaded and kept current as they change. */
interface ArtifactsShelf {
  place: Place;
  project: ProjectSummary | null;
  artifacts: ArtifactSummary[] | null;
  failure: string | null;
}

/** Loads a Project's Artifacts, or the Workspace's own, and loads them again as they change. */
function useArtifacts(workspace: Workspace, project: ProjectSummary | null): ArtifactsShelf {
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
  return { place, project, artifacts, failure };
}

/** The Artifacts page: each place's Artifacts as its own section, the Project's before the Workspace's. */
function ArtifactsPage({ workspace, project, shelves }: { workspace: Workspace; project: ProjectSummary | null; shelves: ArtifactsShelf[] }) {
  return (
    <div className="page">
      <PageHead
        crumbs={knowledgeCrumbs(workspace, project, "Artifacts")}
        title="Artifacts"
        switcher={<LiveIndicator workspaceId={workspace.id} />}
      />
      {shelves.map((shelf) => (
        <ArtifactsSection key={shelf.place.id} shelf={shelf} />
      ))}
    </div>
  );
}

/**
 * One place's Artifacts as a section: its heading, then a table of them, last changed first, or its empty state. It
 * has no action, since Artifacts are created over the API and MCP.
 */
function ArtifactsSection({ shelf }: { shelf: ArtifactsShelf }) {
  const to = useAddresses();
  const { project, artifacts, failure } = shelf;
  const arrived = useArrivals(artifacts?.map((a) => a.id) ?? [], artifacts !== null);
  return (
    <KnowledgeSection project={project}>
      {project && <ProjectNote project={project} />}
      <FormError error={failure} />
      {artifacts &&
        (artifacts.length === 0 ? (
          <EmptyState title="No Artifacts yet.">
            Agents and Users create them over the API and MCP; one an Agent makes during a Run is linked to its Ticket.
          </EmptyState>
        ) : (
          <div className="panel panel-flush">
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
                      <Link to={to.artifact(artifact)}>{artifact.title}</Link>
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
          </div>
        ))}
    </KnowledgeSection>
  );
}

/** The Workspace's own Artifacts, separate from its Projects': its section alone. */
export function WorkspaceArtifacts({ workspace }: { workspace: Workspace }) {
  usePlace("artifacts");
  const own = useArtifacts(workspace, null);
  return <ArtifactsPage workspace={workspace} project={null} shelves={[own]} />;
}

/** A Project's Artifacts, then the Workspace's. */
export function ProjectArtifacts({ workspace, project }: { workspace: Workspace; project: ProjectSummary }) {
  usePlace("artifacts", project.id);
  const own = useArtifacts(workspace, project);
  const workspaces = useArtifacts(workspace, null);
  return <ArtifactsPage workspace={workspace} project={project} shelves={[own, workspaces]} />;
}

/**
 * An Artifact's page: the Artifact itself in an iframe sandboxed as its address serves it, scripts allowed and its
 * origin opaque, so it never acts as the signed-in User (ADR 0004); with its files beside it.
 */
export function ArtifactScreen({
  workspace,
  user,
  artifactId,
}: {
  workspace: Workspace;
  user: User;
  artifactId: string;
}) {
  const to = useAddresses();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { gone, failed, deleteHere } = useDeletedElsewhere();
  // Counts the Artifact's changes, so its Versions are read again when one is deleted elsewhere.
  const [revision, setRevision] = useState(0);
  usePlace("artifacts", artifact?.projectId ?? null);
  // An Embed's Open, or any address, may name a Version (`?version=N`): shown in place of the current one.
  const asked = Number(useQuery().get("version"));
  const pinned = Number.isInteger(asked) && asked > 0 ? asked : null;

  useEffect(() => {
    api.artifact(artifactId, pinned).then(
      (found) => {
        if (found.workspaceId === workspace.id) setArtifact(found);
        else setFailure("No such Artifact.");
      },
      (e: Error) => setFailure(e.message),
    );
  }, [artifactId, workspace.id, pinned]);
  const latest = useLatest();
  /** Fetches the shown Artifact again after a live event, keeping it on screen if it went meanwhile. */
  const reload = useCallback(
    () => latest(api.artifact(artifactId, pinned), setArtifact, failed),
    [artifactId, pinned, latest, failed],
  );
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "artifact.changed" && event.artifactId === artifactId)) {
      reload();
      setRevision((n) => n + 1);
    }
  });
  const projectId = artifact?.projectId ?? null;
  useEffect(() => {
    if (projectId) api.project(projectId).then(setProject, () => setProject(null));
  }, [projectId]);

  useCanonicalAddress(artifact && !gone ? to.artifact(artifact) : null);

  if (failure) return <FormError error={failure} />;
  if (!artifact) return <p className="muted">Loading…</p>;
  const list = to.place(artifact.projectId ? { kind: "project", id: artifact.projectId } : { kind: "workspace", id: artifact.workspaceId }, "artifacts");
  const crumbs = [
    workspaceCrumb(workspace),
    ...(project ? [{ label: <span className="mono">{project.key}</span>, to: to.tickets(project) }] : []),
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
              {/* With Read in its Project, the Artifact is only opened, never deleted. */}
              {(!project || project.access === "write") && (
                <Menu label="More of this Artifact">
                  <MenuItem tone="danger" onSelect={() => setDeleting(true)}>
                    Delete Artifact
                  </MenuItem>
                </Menu>
              )}
              <a className={buttonClass()} href={artifact.url} target="_blank" rel="noopener noreferrer">
                Open
              </a>
            </>
          )
        }
      />
      {project && <ProjectNote project={project} />}
      {gone && <DeletedElsewhere back={{ to: list, label: "Back to Artifacts" }}>this Artifact is no longer kept.</DeletedElsewhere>}
      {pinned !== null && (
        <Banner tone="info">
          This is Version {pinned}, as the address names it. <Link to={to.artifact(artifact)}>Show the latest</Link>
        </Banner>
      )}
      {artifact.description && <p className="artifact-description">{artifact.description}</p>}
      <div className="page-split">
        <ArtifactFrame url={artifact.url} title={artifact.title} className="artifact-frame" />
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
          <Versions<VersionWithBody, ArtifactComparison>
            current={artifact.version.number}
            revision={revision}
            // With Read in its Project, or once it is gone, no Version is deleted.
            deleting={
              !gone && (!project || project.access === "write")
                ? {
                    run: (number) => api.deleteArtifactVersion(artifact.id, number),
                    note: "It goes with its files, which are no longer served, and its number is never used again. The other Versions stay. It can't be brought back.",
                  }
                : undefined
            }
            source={{
              list: () => api.artifactVersions(artifact.id),
              compare: (from, to) => api.compareArtifactVersions(artifact.id, from, to),
              showComparison: (comparison) => <ComparedFiles comparison={comparison} />,
            }}
          />
        </aside>
      </div>
      {!gone && (
        // The Workspace's own Artifacts are for every User to change; a Project's, with Write in it.
        <ProjectAccessProvider access={project?.access ?? "write"}>
          <ArtifactComments workspace={workspace} artifactId={artifact.id} user={user} />
        </ProjectAccessProvider>
      )}
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

/** The Artifact's Comments panel, with the Comments it keeps up to date. */
function ArtifactComments({ workspace, artifactId, user }: { workspace: Workspace; artifactId: string; user: User }) {
  const target = { kind: "artifact", id: artifactId } as const;
  return <CommentsPanel target={target} user={user} comments={useComments(workspace, target)} />;
}
