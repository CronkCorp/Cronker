import { useInfiniteQuery } from "@tanstack/react-query";
import { useAddresses } from "./addresses.js";
import { api, type AgentRecord, type Change, type RecordEntry } from "./api.js";
import { keys } from "./live-queries.js";
import { Markdown } from "./markdown.js";
import { Link } from "./router.js";
import { describedWithLink } from "./tickets.js";
import { Actor, Avatar } from "./ui/actor.js";
import { Button, FormError, Panel, RelativeTime } from "./ui/controls.js";
import { Key, KindLabel, ModelLabel, RunState } from "./ui/labels.js";

type RecordAgent = AgentRecord["agent"];

/** An Agent's Record, page by page: the first page names the Agent, removed or not, and Load more fetches older ones. */
export function useAgentRecord(agentId: string) {
  return useInfiniteQuery({
    queryKey: keys.agentRecord(agentId),
    queryFn: ({ pageParam }) => api.agentRecord(agentId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
  });
}

const versionNouns: Record<Extract<RecordEntry, { kind: "version" }>["of"]["kind"], string> = {
  document: "Document",
  report: "Report",
  term: "Term",
  decision: "Decision",
  artifact: "Artifact",
};

/**
 * The Agent Record: everything the Agent did across the Workspace that the viewer can read, newest first, each entry
 * styled as on a Ticket's timeline. It follows live updates.
 */
export function AgentRecordPanel({ agentId }: { agentId: string }) {
  const record = useAgentRecord(agentId);
  const pages = record.data?.pages ?? [];
  const agent = pages[0]?.agent;
  const entries = pages.flatMap((page) => page.entries);
  return (
    <Panel title="Record" id="record" description="Everything it did across the Workspace that you can read, newest first.">
      <FormError error={record.error?.message ?? null} />
      {!agent ? (
        !record.error && <p className="muted small">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <ol className="timeline agent-record" aria-label="Record">
          {entries.map((entry) => (
            <RecordRow key={`${entry.kind}:${entry.id}`} entry={entry} agent={agent} />
          ))}
        </ol>
      )}
      {record.hasNextPage && (
        <Button onClick={() => void record.fetchNextPage()} disabled={record.isFetchingNextPage}>
          {record.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </Panel>
  );
}

function RecordRow({ entry, agent }: { entry: RecordEntry; agent: RecordAgent }) {
  const to = useAddresses();
  const actor = { kind: "agent" as const, id: agent.id, name: agent.name };
  const when = <RelativeTime at={entry.at} />;
  const ticketLink = (ticket: { key: string; title: string }) => (
    <Link to={to.ticket(ticket)} title={ticket.title}>
      <Key>{ticket.key}</Key>
    </Link>
  );
  if (entry.kind === "change") {
    const change = { ...entry, actor } as unknown as Change;
    return (
      <li className="entry">
        <span className="gutter">
          <span className="ring" />
        </span>
        <p className="entry-line">
          <Actor actor={actor} avatar={false} /> {describedWithLink(change)} on {ticketLink(entry.ticket)} {when}
        </p>
      </li>
    );
  }
  if (entry.kind === "run") {
    return (
      <li className="entry entry-run">
        <span className="gutter">
          <Avatar actor={actor} />
        </span>
        <p className="entry-line">
          <KindLabel kind="Run" /> <RunState state={entry.state as Parameters<typeof RunState>[0]["state"]} />{" "}
          {ticketLink(entry.ticket)}{" "}
          <span>
            {entry.step} · <ModelLabel model={entry.model} />
          </span>
          {entry.outcome && <span> · {entry.outcome}</span>} {when}
          {entry.transcript && (
            <>
              {" "}
              <Link to={to.transcript(entry.transcript)} className="small">
                Transcript
              </Link>
            </>
          )}
        </p>
      </li>
    );
  }
  if (entry.kind === "transcript") {
    return (
      <li className="entry entry-run">
        <span className="gutter">
          <Avatar actor={actor} />
        </span>
        <p className="entry-line">
          <KindLabel kind="Transcript" /> a session outside a Run
          {entry.tickets.length > 0 && <> naming {entry.tickets.map((ticket) => <span key={ticket.id}>{ticketLink(ticket)} </span>)}</>}{" "}
          · {entry.entryCount} {entry.entryCount === 1 ? "entry" : "entries"} {when}{" "}
          <Link to={to.transcript(entry)} className="small">
            Transcript
          </Link>
        </p>
      </li>
    );
  }
  if (entry.kind === "version") {
    const { of } = entry;
    const page =
      of.kind === "report" && of.ticket
        ? to.ticket(of.ticket)
        : of.kind === "term"
          ? to.term({ id: of.id, projectId: of.projectId, name: of.current })
          : of.kind === "decision"
            ? to.decision({ id: of.id, projectId: of.projectId, number: of.decisionNumber ?? 0 })
            : of.kind === "artifact"
              ? to.artifact({ slug: of.slug ?? of.id })
              : to.document({ slug: of.slug ?? of.id });
    return (
      <li className="entry">
        <span className="gutter">
          <span className="ring" />
        </span>
        <p className="entry-line">
          <Actor actor={actor} avatar={false} /> saved Version {entry.number} of the {versionNouns[of.kind]}{" "}
          <Link to={page}>{of.title}</Link>
          {of.kind === "report" && of.ticket && <> on {ticketLink(of.ticket)}</>} {when}
        </p>
      </li>
    );
  }
  return (
    <li className="entry">
      <span className="gutter">
        <Avatar actor={actor} />
      </span>
      <article className="entry-body" aria-label={`Comment by ${agent.name}`}>
        <p className="entry-head">
          <Actor actor={actor} avatar={false} /> {entry.replyToId ? "replied" : "commented"} on{" "}
          {entry.ticket ? ticketLink(entry.ticket) : entry.artifact && <Link to={to.artifact(entry.artifact)}>{entry.artifact.title}</Link>}{" "}
          {when}
        </p>
        <div className="bubble">
          <Markdown text={entry.body} mentions={[]} />
        </div>
      </article>
    </li>
  );
}
