import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAddresses } from "./addresses.js";
import { api, ApiError, type OpenReleaseTicket, type Project, type Release, type WorkspaceSummary } from "./api.js";
import { field, useSubmit } from "./forms.js";
import { usePlace } from "./frame.js";
import { keys } from "./live-queries.js";
import { ProjectMenu } from "./projects.js";
import { Link } from "./router.js";
import { Button, EmptyState, ExternalLink, Field, FormError, LiveIndicator, PageHead, RelativeTime, workspaceCrumb } from "./ui/controls.js";
import { Chip, Key, StatusDot, type Tone } from "./ui/labels.js";
import { ConfirmDialog, Dialog, DialogActions, DialogClose, Menu, MenuItem } from "./ui/overlays.js";
import { ReadOnlyNote } from "./write-access.js";

const stateTones: Record<Release["state"], Tone> = { planned: "neutral", cut: "info", released: "ok" };
const stateWords: Record<Release["state"], string> = { planned: "Planned", cut: "Cut", released: "Released" };

/** A Release's state as a chip: Planned, Cut or Released. */
export function ReleaseState({ state }: { state: Release["state"] }) {
  return <Chip tone={stateTones[state]}>{stateWords[state]}</Chip>;
}

/**
 * A Project's Releases, newest first: each with its state, release branch, how many of its Tickets are open and done,
 * and its Tickets; a cut one with who cut it, when, and each Repository's cut commit; a released one with who released
 * it, when, and each Repository's tag and GitHub Release. With Write, New Release, Cut…, Rename… and Delete… on a
 * planned one, and Release… on a cut one.
 */
export function ProjectReleases({
  workspace,
  project,
  onChange,
}: {
  workspace: WorkspaceSummary;
  project: Project;
  onChange: (project: Project) => void;
}) {
  usePlace("project", project.id);
  const to = useAddresses();
  const releasesQuery = useQuery({ queryKey: keys.releases(project.id), queryFn: () => api.releases(project.id) });
  const releases = releasesQuery.data ?? null;
  const canWrite = project.access === "write";
  return (
    <div className="page">
      <PageHead
        crumbs={[workspaceCrumb(workspace), { label: <span className="mono">{project.key}</span>, to: to.project(project) }]}
        title="Releases"
        switcher={<LiveIndicator workspaceId={workspace.id} />}
        actions={
          <>
            <ProjectMenu project={project} workspace={workspace} onChange={onChange} />
            {canWrite && <NewRelease project={project} />}
          </>
        }
      />
      {project.archivedAt === null && <ReadOnlyNote access={project.access} />}
      <FormError error={releasesQuery.error?.message ?? null} />
      {releases &&
        (releases.length === 0 ? (
          <EmptyState title="No Releases yet.">
            A Release names what ships together, such as v0.3.0: tag Tickets with it from their page.
          </EmptyState>
        ) : (
          <div className="release-list">
            {releases.map((release) => (
              <ReleaseCard key={release.id} project={project} release={release} canWrite={canWrite} />
            ))}
          </div>
        ))}
    </div>
  );
}

function ReleaseCard({ project, release, canWrite }: { project: Project; release: Release; canWrite: boolean }) {
  const to = useAddresses();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const statusOf = (statusId: string) => project.statuses.find((s) => s.id === statusId);
  const editable = canWrite && release.state === "planned";
  return (
    <section className="panel release" aria-label={`Release ${release.name}`}>
      <div className="release-head">
        <h2 className="mono">{release.name}</h2>
        <ReleaseState state={release.state} />
        <span className="mono muted small">{release.branch}</span>
        <span className="muted small release-counts">
          {release.openCount} open · {release.doneCount} done
        </span>
        {editable && (
          <Button size="small" onClick={() => setCutting(true)}>
            Cut…
          </Button>
        )}
        {canWrite && release.state === "cut" && (
          <Button size="small" onClick={() => setReleasing(true)}>
            Release…
          </Button>
        )}
        {editable && (
          <Menu label={`More of ${release.name}`}>
            <MenuItem onSelect={() => setRenaming(true)}>Rename…</MenuItem>
            <MenuItem onSelect={() => setDeleting(true)}>Delete…</MenuItem>
          </Menu>
        )}
      </div>
      {release.cutAt && (
        <div className="release-cut small">
          <p className="muted">
            Cut{release.cutBy && <> by {release.cutBy.name}</>} <RelativeTime at={release.cutAt} />
            {release.releasedAt && (
              <>
                {" · "}Released{release.releasedBy && <> by {release.releasedBy.name}</>} <RelativeTime at={release.releasedAt} />
              </>
            )}
          </p>
          <ul className="release-commits" aria-label={`Commits ${release.name} was cut at`}>
            {release.repositories.map(({ repository, commit, tag, releaseUrl }) => (
              <li key={repository.id}>
                <span className="mono">{repository.fullName}</span>{" "}
                <span className="mono muted" title={commit}>
                  {commit.slice(0, 7)}
                </span>
                {releaseUrl && (
                  <>
                    {" "}
                    <ExternalLink url={releaseUrl}>
                      GitHub Release <span className="mono">{tag}</span>
                    </ExternalLink>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {release.tickets.length === 0 ? (
        <p className="muted small">No Tickets yet.</p>
      ) : (
        <ul className="release-tickets">
          {release.tickets.map((ticket) => {
            const status = statusOf(ticket.statusId);
            return (
              <li key={ticket.id}>
                {status && <StatusDot kind={status.kind} name={status.name} alone />}
                <Link to={to.ticket(ticket)}>
                  <Key>{ticket.key}</Key> {ticket.title}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <RenameRelease project={project} release={release} open={renaming} onOpenChange={setRenaming} />
      <CutRelease project={project} release={release} open={cutting} onOpenChange={setCutting} />
      {releasing && <PublishRelease project={project} release={release} onClose={() => setReleasing(false)} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${release.name}?`}
        confirm="Delete"
        onConfirm={async () => {
          await api.deleteRelease(project.id, release.id);
          setDeleting(false);
        }}
      >
        {release.tickets.length === 1
          ? "Its Ticket is untagged, and its timeline records it."
          : release.tickets.length > 1
            ? `Its ${release.tickets.length} Tickets are untagged, and their timelines record it.`
            : "It has no Tickets."}
      </ConfirmDialog>
    </section>
  );
}

const nameHint = "A semantic version, such as v0.3.0 or 1.2.0-rc.1.";

function NewRelease({ project }: { project: Project }) {
  const [open, setOpen] = useState(false);
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api.createRelease(project.id, field(form, "name"));
    setOpen(false);
  });
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        New Release
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={`New Release in ${project.name}`}>
        <form onSubmit={onSubmit}>
          <Field label="Name" hint={nameHint}>
            <input name="name" required maxLength={100} autoFocus className="mono" placeholder="v0.3.0" />
          </Field>
          <FormError error={error} />
          <DialogActions>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary" disabled={busy}>
              Create Release
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}

function RenameRelease({
  project,
  release,
  open,
  onOpenChange,
}: {
  project: Project;
  release: Release;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { error, busy, onSubmit } = useSubmit(async (form) => {
    await api.renameRelease(project.id, release.id, field(form, "name"));
    onOpenChange(false);
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Rename ${release.name}`}>
      <form onSubmit={onSubmit}>
        <Field label="Name" hint={`${nameHint} Its Tickets stay tagged with it.`}>
          <input name="name" required maxLength={100} autoFocus className="mono" defaultValue={release.name} />
        </Field>
        <FormError error={error} />
        <DialogActions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={busy}>
            Rename
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** Confirms a Cut, listing the Repositories Cronk creates the release branch in; a refusal shows in the dialog. */
function CutRelease({
  project,
  release,
  open,
  onOpenChange,
}: {
  project: Project;
  release: Release;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const repositories = useQuery({
    queryKey: ["project", project.id, "repositories"],
    queryFn: () => api.repositories(project.id),
    enabled: open,
  });
  const listed = repositories.data ?? null;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Cut ${release.name}?`}
      confirm="Cut"
      onConfirm={async () => {
        await api.cutRelease(project.id, release.id);
        onOpenChange(false);
      }}
    >
      {listed === null ? (
        "Cronk creates its release branch at the head of each Repository's default branch."
      ) : listed.length === 0 ? (
        `${project.key} lists no Repositories yet: add them in Project settings first.`
      ) : (
        <>
          Cronk creates <span className="mono">{release.branch}</span> at the head of the default branch in{" "}
          {listed.map((repository, i) => (
            <span key={repository.id}>
              {i > 0 && (i === listed.length - 1 ? " and " : ", ")}
              <span className="mono">{repository.fullName}</span>
            </span>
          ))}
          . It can't be renamed or deleted afterwards, and its Tickets stay tagged.
        </>
      )}
    </ConfirmDialog>
  );
}

/**
 * Releases a cut Release: takes the Upgrade notes its GitHub Releases' notes start with. A refusal for open Tickets
 * lists them and offers Release anyway, which resends with `confirm`; any other refusal shows in the dialog.
 */
function PublishRelease({ project, release, onClose }: { project: Project; release: Release; onClose: () => void }) {
  const [upgradeNotes, setUpgradeNotes] = useState("");
  const [openTickets, setOpenTickets] = useState<OpenReleaseTicket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const publish = async (confirm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.releaseRelease(project.id, release.id, { upgradeNotes, confirm });
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.code === "release_has_open_tickets" && Array.isArray(e.body.openTickets)) {
        setOpenTickets(e.body.openTickets as OpenReleaseTicket[]);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };
  const repositories = release.repositories.map((r) => r.repository.fullName);
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Release ${release.name}?`}
      description={
        <>
          Cronk tags the head of <span className="mono">{release.branch}</span> <span className="mono">{release.name}</span> and
          creates a GitHub Release in {repositories.join(", ") || "each Repository it was cut in"}, with notes listing its
          Tickets. Its Tickets can't be changed afterwards.
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void publish(openTickets !== null);
        }}
      >
        <Field label="Upgrade notes" hint="Markdown, shown before the Tickets in the notes. Leave it blank to have none.">
          <textarea
            name="upgradeNotes"
            rows={5}
            maxLength={20000}
            value={upgradeNotes}
            onChange={(event) => setUpgradeNotes(event.currentTarget.value)}
            autoFocus
          />
        </Field>
        {openTickets && (
          <div className="release-open" role="alert">
            <p>
              {openTickets.length === 1 ? "1 Ticket is" : `${openTickets.length} Tickets are`} still open:
            </p>
            <ul aria-label={`Open Tickets of ${release.name}`}>
              {openTickets.map((ticket) => (
                <li key={ticket.key}>
                  <Key>{ticket.key}</Key> {ticket.title} <span className="muted">({ticket.status})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <FormError error={error} />
        <DialogActions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant={openTickets ? "danger" : "primary"} disabled={busy}>
            {openTickets ? "Release anyway" : "Release"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
