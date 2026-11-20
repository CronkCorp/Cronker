import { useEffect, useState } from "react";
import { api, type Project, type Run, type Ticket, type Transcript, type TranscriptEntry, type Workspace } from "./api.js";
import { usePlace } from "./frame.js";
import { Markdown } from "./markdown.js";
import { Actor } from "./ui/actor.js";
import {
  Button,
  EmptyState,
  ExternalLink,
  FormError,
  PageHead,
  RelativeTime,
  workspaceCrumb,
  type Crumb,
} from "./ui/controls.js";
import { Chip, KindLabel, ModelLabel } from "./ui/labels.js";

/**
 * A Transcript's page: the conversation's messages in full, each tool call collapsed to its name and a one-line
 * summary of what it was called with, opening on click to its input and result. Entries load a page at a time.
 */
export function TranscriptScreen({ workspace, transcriptId }: { workspace: Workspace; transcriptId: string }) {
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  // The Run the Transcript records, with its Ticket and Project, for the page head.
  const [ofRun, setOfRun] = useState<{ run: Run; ticket: Ticket; project: Project } | null>(null);
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  usePlace("project", ofRun?.project.id ?? null);

  useEffect(() => {
    let current = true;
    const fail = (error: Error) => current && setFailure(error.message);
    api
      .transcript(transcriptId)
      .then(async (found) => {
        if (!current) return;
        setTranscript(found);
        const page = await api.transcriptEntries(transcriptId);
        if (!current) return;
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

  const more = () => {
    if (next === null) return;
    setLoading(true);
    api
      .transcriptEntries(transcriptId, next)
      .then((page) => {
        setEntries((shown) => [...shown, ...page.entries]);
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
      { label: <span className="mono">{ofRun.project.key}</span>, to: `/projects/${ofRun.project.id}` },
      { label: <span className="mono">{ofRun.ticket.key}</span>, to: `/tickets/${ofRun.ticket.id}` },
    );
  } else {
    crumbs.push({ label: "Agents", to: `/workspaces/${workspace.id}/agents` });
  }
  crumbs.push({ label: "Transcript" });

  const agent = { kind: "agent" as const, name: transcript.agent.name };
  return (
    <div className="page transcript-page">
      <PageHead
        crumbs={crumbs}
        title={run ? `Transcript of the ${run.step.name} Run` : "Transcript"}
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
            <span>
              {transcript.entryCount} {transcript.entryCount === 1 ? "entry" : "entries"}, uploaded{" "}
              <RelativeTime at={transcript.uploadedAt} />
            </span>
            {run?.sessionUrl && <ExternalLink url={run.sessionUrl}>Session</ExternalLink>}
          </span>
        }
      />
      <FormError error={failure} />
      {entries.length === 0 ? (
        <EmptyState title="Nothing was said in this session yet.">
          Its entries appear once the agent's next turn is uploaded.
        </EmptyState>
      ) : (
        <ol className="transcript" aria-label="Entries">
          {entries.map((entry) => (
            <TranscriptItem key={entry.position} entry={entry} agentName={transcript.agent.name} gap={transcript.gap} />
          ))}
        </ol>
      )}
      {next !== null && (
        <Button variant="secondary" disabled={loading} onClick={more}>
          Show more
        </Button>
      )}
    </div>
  );
}

/** An entry, followed by the mark of the gap after it when that is where a Transcript past 50 MB was cut. */
function TranscriptItem({ entry, agentName, gap }: { entry: TranscriptEntry; agentName: string; gap: Transcript["gap"] }) {
  return (
    <>
      {entry.toolName === null ? <Message entry={entry} agentName={agentName} /> : <ToolCall entry={entry} />}
      {gap && gap.after === entry.position && <Gap gap={gap} />}
    </>
  );
}

/** Who said a message: the Agent, what it was sent (its Brief, a tool's answer, the session's notes) or the system. */
function Speaker({ entry, agentName }: { entry: TranscriptEntry; agentName: string }) {
  if (entry.role === "assistant") return <Actor actor={{ kind: "agent", name: agentName }} />;
  return <KindLabel kind={entry.role === "system" ? "System" : "Input"} />;
}

function Message({ entry, agentName }: { entry: TranscriptEntry; agentName: string }) {
  return (
    <li className={`transcript-entry transcript-${entry.role}`}>
      <div className="entry-head">
        <Speaker entry={entry} agentName={agentName} />
        {entry.at && <RelativeTime at={entry.at} clock />}
      </div>
      {entry.text !== null && (
        <div className="bubble">
          <Markdown text={entry.text} mentions={[]} />
        </div>
      )}
      {entry.toolResult !== null && <ToolResult entry={entry} />}
    </li>
  );
}

/** A tool call as one line, its name and a summary of its input, opening on click to the input and the result. */
function ToolCall({ entry }: { entry: TranscriptEntry }) {
  const [open, setOpen] = useState(false);
  const summary = summarize(entry.toolInput);
  return (
    <li className="transcript-entry transcript-tool">
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
            <pre>{JSON.stringify(entry.toolInput, null, 2)}</pre>
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
      {entry.cut && <p className="small muted">Cut at 20 KB: only the start of this result was kept.</p>}
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

