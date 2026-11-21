import { useAddresses } from "./addresses.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Project, type Run, type Ticket, type Transcript, type TranscriptEntry, type Workspace } from "./api.js";
import { usePlace } from "./frame.js";
import { useArrivals, useDeletedElsewhere, useLatest, useLiveEvents } from "./live.js";
import { Markdown } from "./markdown.js";
import { Link, navigate } from "./router.js";
import { Actor } from "./ui/actor.js";
import {
  Button,
  DeletedElsewhere,
  EmptyState,
  ExternalLink,
  FormError,
  LiveIndicator,
  PageHead,
  RelativeTime,
  workspaceCrumb,
  type Crumb,
} from "./ui/controls.js";
import { Chip, KindLabel, ModelLabel } from "./ui/labels.js";
import { ConfirmDialog, Menu, MenuItem } from "./ui/overlays.js";

/**
 * The entries of a Transcript from its start, a page at a time until at least `count` are read or none are left;
 * with `count` Infinity, all of them.
 */
async function entriesFromStart(transcriptId: string, count: number): Promise<{ entries: TranscriptEntry[]; next: number | null }> {
  const entries: TranscriptEntry[] = [];
  let next: number | null = null;
  do {
    const page = await api.transcriptEntries(transcriptId, next ?? undefined);
    entries.push(...page.entries);
    next = page.next;
  } while (next !== null && entries.length < count);
  return { entries, next };
}

/**
 * A Transcript's page: the conversation's messages in full, each tool call collapsed to its name and a one-line
 * summary of what it was called with, opening on click to its input and result. Entries load a page at a time.
 * It follows new uploads of its session live, so a running Run's turns appear as they arrive, and offers Users
 * Delete, for when the scrubbing missed a secret.
 */
export function TranscriptScreen({ workspace, transcriptId }: { workspace: Workspace; transcriptId: string }) {
  const to = useAddresses();
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  // The Run the Transcript records, with its Ticket and Project, for the page head.
  const [ofRun, setOfRun] = useState<{ run: Run; ticket: Ticket; project: Project } | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const { gone, failed, deleteHere } = useDeletedElsewhere();
  usePlace("project", ofRun?.project.id ?? null);
  // How far the page has read, so a refetch after an upload reads at least as far again: to the end when it was
  // there, so the session's new turns appear, else as many entries as are shown, leaving the rest to Show more.
  const shown = useRef(0);
  shown.current = transcript !== null && next === null ? Infinity : entries.length;

  useEffect(() => {
    let current = true;
    const fail = (error: Error) => current && setFailure(error.message);
    api
      .transcript(transcriptId)
      .then(async (found) => {
        const page = await api.transcriptEntries(transcriptId);
        if (!current) return;
        // Shown together, so the first entries don't count as arrivals.
        setTranscript(found);
        setEntries(page.entries);
        setNext(page.next);
        if (!found.runId) return;
        const foundRun = await api.run(found.runId);
        const ticket = await api.ticket(foundRun.ticketId);
        const project = await api.project(ticket.projectId);
        if (current) setOfRun({ run: foundRun, ticket, project });
      })
      .catch(fail);
    return () => {
      current = false;
    };
  }, [transcriptId]);

  // A new upload replaces the session's entries: read them again, as far as shown, plus whatever came after.
  const latest = useLatest();
  const refresh = useCallback(() => {
    latest(
      Promise.all([api.transcript(transcriptId), entriesFromStart(transcriptId, shown.current)]),
      ([found, page]) => {
        setTranscript(found);
        setEntries(page.entries);
        setNext(page.next);
      },
      failed,
    );
  }, [transcriptId, latest, failed]);
  useLiveEvents(workspace.id, (event) => {
    if (event.type === "reconnected" || (event.type === "transcript.changed" && event.transcriptId === transcriptId)) refresh();
  });
  const arrived = useArrivals(entries.map((entry) => String(entry.position)), transcript !== null);

  const more = () => {
    if (next === null) return;
    setLoading(true);
    api
      .transcriptEntries(transcriptId, next)
      .then((page) => {
        // A live refresh may have read past where this page starts meanwhile: add only what is still new.
        setEntries((shown) => {
          const last = shown.at(-1)?.position ?? 0;
          return [...shown, ...page.entries.filter((entry) => entry.position > last)];
        });
        setNext(page.next);
      })
      .catch((error: Error) => setFailure(error.message))
      .finally(() => setLoading(false));
  };

  if (failure && !transcript) {
    return (
      <div className="page">
        <EmptyState title="This Transcript can't be shown.">{failure}</EmptyState>
      </div>
    );
  }
  if (!transcript) return <div className="page" aria-busy="true" />;

  const crumbs: Crumb[] = [workspaceCrumb(workspace)];
  const run = ofRun?.run;
  if (ofRun) {
    crumbs.push(
      { label: <span className="mono">{ofRun.project.key}</span>, to: to.project(ofRun.project) },
      { label: <span className="mono">{ofRun.ticket.key}</span>, to: to.ticket(ofRun.ticket) },
    );
  } else {
    crumbs.push(
      { label: "Agents", to: to.workspace("agents") },
      { label: transcript.agent.name, to: to.agent(transcript.agent.id) },
    );
  }
  crumbs.push({ label: "Transcript" });

  const agent = { kind: "agent" as const, name: transcript.agent.name };
  // Where the page leads once the Transcript is gone: its Run's Ticket, or its Agent's page.
  const back = ofRun
    ? { to: to.ticket(ofRun.ticket), label: `Back to ${ofRun.ticket.key}` }
    : { to: to.agent(transcript.agent.id), label: `Back to ${transcript.agent.name}` };
  return (
    <div className="page transcript-page">
      <PageHead
        crumbs={crumbs}
        title={
          run
            ? `Transcript of the ${run.step.name} Run`
            : transcript.runId
              ? "Transcript"
              : `Transcript of a ${transcript.agent.name} session`
        }
        switcher={<LiveIndicator workspaceId={workspace.id} />}
        actions={
          !gone && (
            <Menu label="More of this Transcript">
              <MenuItem tone="danger" onSelect={() => setDeleting(true)}>
                Delete Transcript
              </MenuItem>
            </Menu>
          )
        }
        meta={
          <span className="transcript-meta">
            <Actor actor={agent} />
            {ofRun && (
              <>
                <span>
                  on <span className="mono">{ofRun.ticket.key}</span> {ofRun.ticket.title}
                </span>
                <ModelLabel model={ofRun.run.model} />
              </>
            )}
            {!transcript.runId && (
              <span>
                session <span className="mono">{transcript.sessionId}</span>
              </span>
            )}
            {transcript.tickets.length > 0 && (
              <span>
                naming{" "}
                {transcript.tickets.map((ticket, index) => (
                  <span key={ticket.id}>
                    {index > 0 && ", "}
                    <Link to={to.ticket(ticket)} className="mono" title={ticket.title}>
                      {ticket.key}
                    </Link>
                  </span>
                ))}
              </span>
            )}
            <span>
              {transcript.entryCount} {transcript.entryCount === 1 ? "entry" : "entries"}, uploaded{" "}
              <RelativeTime at={transcript.uploadedAt} />
            </span>
            {run?.sessionUrl && <ExternalLink url={run.sessionUrl}>Session</ExternalLink>}
          </span>
        }
      />
      {gone && <DeletedElsewhere back={back}>this Transcript's entries are gone.</DeletedElsewhere>}
      <FormError error={failure} />
      {entries.length === 0 ? (
        <EmptyState title="Nothing was said in this session yet.">
          Its entries appear once the agent's next turn is uploaded.
        </EmptyState>
      ) : (
        <ol className="transcript" aria-label="Entries">
          {entries.map((entry) => (
            <TranscriptItem
              key={entry.position}
              entry={entry}
              agentName={transcript.agent.name}
              gap={transcript.gap}
              arrived={arrived.has(String(entry.position))}
            />
          ))}
        </ol>
      )}
      {next !== null && !gone && (
        <Button variant="secondary" disabled={loading} onClick={more}>
          Show more
        </Button>
      )}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={run ? `Delete the Transcript of the ${run.step.name} Run?` : "Delete this Transcript?"}
        confirm="Delete"
        onConfirm={async () => {
          await deleteHere(() => api.deleteTranscript(transcript.id));
          navigate(back.to);
        }}
      >
        All its entries go, for good{run ? `; the Run keeps its Session link and says its Transcript was deleted` : ""}. Later
        uploads of its session are refused, so nothing it was deleted for comes back.
      </ConfirmDialog>
    </div>
  );
}

/** An entry, followed by the mark of the gap after it when that is where a Transcript past 50 MB was cut. */
function TranscriptItem({
  entry,
  agentName,
  gap,
  arrived,
}: {
  entry: TranscriptEntry;
  agentName: string;
  gap: Transcript["gap"];
  /** Whether it arrived with an upload since the page loaded, for the short accent ring. */
  arrived: boolean;
}) {
  return (
    <>
      {entry.toolName === null ? (
        <Message entry={entry} agentName={agentName} arrived={arrived} />
      ) : (
        <ToolCall entry={entry} arrived={arrived} />
      )}
      {gap && gap.after === entry.position && <Gap gap={gap} />}
    </>
  );
}

/** Who said a message: the Agent, what it was sent (its Brief, a tool's answer, the session's notes) or the system. */
function Speaker({ entry, agentName }: { entry: TranscriptEntry; agentName: string }) {
  if (entry.role === "assistant") return <Actor actor={{ kind: "agent", name: agentName }} />;
  return <KindLabel kind={entry.role === "system" ? "System" : "Input"} />;
}

function Message({ entry, agentName, arrived }: { entry: TranscriptEntry; agentName: string; arrived: boolean }) {
  return (
    <li className={`transcript-entry transcript-${entry.role}${arrived ? " arrived" : ""}`}>
      <div className="entry-head">
        <Speaker entry={entry} agentName={agentName} />
        {entry.at && <RelativeTime at={entry.at} clock />}
      </div>
      {entry.text !== null && (
        <div className="bubble">
          <Markdown text={entry.text} mentions={[]} />
        </div>
      )}
      {entry.cutParts.includes("text") && (
        <p className="small muted">Cut at 20 KB: only the start of this message was kept.</p>
      )}
      {entry.toolResult !== null && <ToolResult entry={entry} />}
    </li>
  );
}

/** A tool call as one line, its name and a summary of its input, opening on click to the input and the result. */
function ToolCall({ entry, arrived }: { entry: TranscriptEntry; arrived: boolean }) {
  const [open, setOpen] = useState(false);
  // A cut input is a string of its JSON's start, shown as it is.
  const inputCut = entry.cutParts.includes("toolInput");
  const summary = inputCut ? oneLine(String(entry.toolInput)) : summarize(entry.toolInput);
  return (
    <li className={`transcript-entry transcript-tool${arrived ? " arrived" : ""}`}>
      <button
        type="button"
        className="tool-line"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title={open ? "Hide the input and result" : "Show the input and result"}
      >
        <span className="tool-caret" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        <span className="tool-name">{entry.toolName}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        {entry.cut && <Chip tone="warn">Cut</Chip>}
        {entry.toolResult === null && <span className="muted small">no result</span>}
      </button>
      {open && (
        <div className="tool-detail">
          <section aria-label="Input">
            <p className="kind-label kind-muted">Input</p>
            <pre>{inputCut ? String(entry.toolInput) : JSON.stringify(entry.toolInput, null, 2)}</pre>
            {inputCut && <p className="small muted">Cut at 20 KB: only the start of this input, as JSON, was kept.</p>}
          </section>
          {entry.toolResult !== null && <ToolResult entry={entry} />}
        </div>
      )}
    </li>
  );
}

function ToolResult({ entry }: { entry: TranscriptEntry }) {
  return (
    <section aria-label="Result">
      <p className="kind-label kind-muted">Result</p>
      <pre>{entry.toolResult || " "}</pre>
      {entry.cutParts.includes("toolResult") && <p className="small muted">Cut at 20 KB: only the start of this result was kept.</p>}
    </section>
  );
}

function Gap({ gap }: { gap: NonNullable<Transcript["gap"]> }) {
  const megabytes = gap.bytes / (1024 * 1024);
  const size = megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.ceil(gap.bytes / 1024)} KB`;
  return (
    <li className="transcript-gap" role="separator" aria-label="Left out">
      {gap.entries} {gap.entries === 1 ? "entry" : "entries"} ({size}) left out here: this Transcript was over 50 MB, so only its start and its end are kept.
    </li>
  );
}

/** The fields a tool's input is best summed up by, in order: what it says it does, then what it acts on. */
const summaryFields = ["description", "command", "file_path", "path", "pattern", "url", "query", "key", "prompt"];

/** One line saying what a tool was called with. */
function summarize(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "object" || Array.isArray(input)) return oneLine(JSON.stringify(input));
  const fields = input as Record<string, unknown>;
  const named = summaryFields.map((field) => fields[field]).find((value) => typeof value === "string" && value.trim());
  if (typeof named === "string") return oneLine(named);
  const firstText = Object.values(fields).find((value) => typeof value === "string" && value.trim());
  if (typeof firstText === "string") return oneLine(firstText);
  const json = JSON.stringify(input);
  return json === "{}" ? "" : oneLine(json);
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

