import { useAddresses } from "./addresses.js";
import { useCallback, useEffect, useRef, useState, type MutableRefObject, type RefObject } from "react";
import { shortcutStandsAside } from "./keys.js";
import {
  api,
  nameOf,
  type Agent,
  type Inbox,
  type InboxItem,
  type Member,
  type Project,
  type PullRequest,
  type Report,
  type Run,
  type User,
  type Workspace,
} from "./api.js";
import { field, useSubmit } from "./forms.js";
import { RichEditor } from "./ui/lazy-rich-editor.js";
import type { RichEditorHandle } from "./ui/rich-editor.js";
import { usePlace } from "./frame.js";
import { useArrivals, useLatest, useLiveEvents } from "./live.js";
import { Markdown } from "./markdown.js";
import { PullRequestRows } from "./pull-requests.js";
import { Link } from "./router.js";
import { Actor } from "./ui/actor.js";
import { Actions, Banner, Button, CommentButton, EmptyState, Field, FormError, LiveIndicator, PageHead, RelativeTime, workspaceCrumb } from "./ui/controls.js";
import { Key, KindLabel, RunState, StatusPill } from "./ui/labels.js";
import { Dialog, DialogActions, DialogClose } from "./ui/overlays.js";
import { FieldPicker } from "./ui/picker.js";

/**
 * The User's Inbox in the Workspace, fetched again after each live event: an Inbox is worked
 * out from current state, so any change in the Workspace may add or remove an item.
 */
function useInbox(workspaceId: string): { inbox: Inbox | null; failure: string | null; reload: () => void } {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const latest = useLatest();
  const load = useCallback(
    () =>
      latest(
        api.inbox(workspaceId),
        (loaded) => {
          setInbox(loaded);
          setFailure(null);
        },
        (e) => setFailure(e.message),
      ),
    [workspaceId, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspaceId, load);
  return { inbox, failure, reload: load };
}

/** The Inbox link for the sidebar, with its count in red. */
export function InboxLink({ workspaceId, current }: { workspaceId: string; current: boolean }) {
  const to = useAddresses();
  const count = useInbox(workspaceId).inbox?.count ?? null;
  const waiting = count === null ? "" : count === 0 ? ", nothing waiting" : `, ${count} waiting`;
  return (
    <Link to={to.workspace("inbox")} current={current} aria-label={`Inbox${waiting}`} className="side-link">
      Inbox{count ? <span className="count">{count}</span> : null}
    </Link>
  );
}

/** An item's key, kept in the address: a Question by its own id, anything else by its kind and Ticket. */
const keyOf = (item: InboxItem) => (item.kind === "question" ? `question:${item.question.id}` : `${item.kind}:${item.ticket.id}`);

/** The Inbox's groups, in the order they are worked through. */
const groups: { name: string; kinds: InboxItem["kind"][] }[] = [
  { name: "Questions", kinds: ["question"] },
  { name: "Needs you", kinds: ["needsYou", "reassign"] },
  { name: "Runs gone wrong", kinds: ["run"] },
  { name: "To review", kinds: ["review"] },
  { name: "Unverified", kinds: ["unverified"] },
  { name: "Discovered", kinds: ["discovered"] },
];

const kindNames: Record<Exclude<InboxItem["kind"], "run">, string> = {
  question: "Question",
  needsYou: "Needs you",
  reassign: "Needs you",
  review: "To review",
  unverified: "Unverified",
  discovered: "Discovered",
};

/** An item's kind label: a Run gone wrong is labelled by how it went wrong. */
const kindOf = (item: InboxItem) =>
  item.kind === "run" ? { failed: "Failed", lost: "Lost", refused: "Couldn't start" }[item.run.state] : kindNames[item.kind];

const wentWrong = { failed: "failed", lost: "was lost", refused: "couldn't start" } as const;

/** Markdown as one line of plain text, for a snippet. */
const plain = (markdown: string) => markdown.replace(/[*_`#>[\]]/g, "").replace(/\s+/g, " ").trim();

/** What an item waits on the User for, in a line. */
function summary(item: InboxItem): string {
  switch (item.kind) {
    case "question":
      return plain(item.question.body);
    case "needsYou":
      return `Handed back to you in ${item.status.name}: the ${item.step.name} Step finished with ${item.outcome}`;
    case "review":
      return `Waiting for your review in ${item.status.name}`;
    case "unverified":
      return item.completedWithoutStep
        ? "Completed outside any Step, Unverified: Accept or Reopen it"
        : `Completed by the ${item.completedBy?.name ?? "removed"} Step, Unverified: Accept or Reopen it`;
    case "run":
      return `Its ${item.run.step.name} Run ${wentWrong[item.run.state]}${item.run.endReason ? `: ${item.run.endReason}` : ""}`;
    case "discovered": {
      const source = item.ticket.discovered?.sourceTicket;
      return `Discovered by ${item.agent.name}${source ? ` while on ${source.key}` : ""}: delegate, move or dismiss it`;
    }
    case "reassign":
      return `${nameOf(item.formerAssignee)} can no longer work on it: assign it to someone`;
  }
}

/** A line as a sentence: a full stop at its end, unless it already ends with one, as a Run's reason may. */
const sentence = (line: string) => (/[.!?]$/.test(line) ? line : `${line}.`);

/** An item's snippet in the list: the Question, or the Report's title on a Ticket to review or verify, else its summary. */
const snippet = (item: InboxItem) =>
  (item.kind === "review" || item.kind === "unverified") && item.report ? `Report: ${item.report.title}` : summary(item);

/** Whether an item waits on an answer or a fix: a coloured left border marks it. */
const tone = (item: InboxItem) =>
  item.kind === "question" || item.kind === "needsYou"
    ? "warn"
    : item.kind === "run" && item.run.state !== "refused"
      ? "danger"
      : item.kind === "run"
        ? "warn"
        : null;

const readSelection = () => new URLSearchParams(window.location.search).get("item");

/** Keeps the selected item in the address without adding a history entry. */
function writeSelection(key: string | null) {
  const params = new URLSearchParams(window.location.search);
  if (key) params.set("item", key);
  else params.delete("item");
  const search = params.toString();
  window.history.replaceState(null, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
}

/** Everything in the Workspace waiting on the signed-in User, as a split view: the list, and the selected item. */
export function InboxScreen({ workspace, user }: { workspace: Workspace; user: User }) {
  usePlace("inbox");
  const { inbox, failure, reload } = useInbox(workspace.id);
  const [selected, setSelected] = useState<string | null>(readSelection);
  // The selected item as last seen, kept while it is resolved elsewhere, until the User moves on.
  const [kept, setKept] = useState<InboxItem | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const answerBox = useRef<RichEditorHandle>(null);
  const acceptRef = useRef<(() => void) | null>(null);

  // Items the User acted on leave at once, before the Inbox comes back without them.
  const [done, setDone] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (inbox) setDone((keys) => new Set([...keys].filter((key) => inbox.items.some((i) => keyOf(i) === key))));
  }, [inbox]);
  const live = inbox ? groups.flatMap((g) => inbox.items.filter((i) => g.kinds.includes(i.kind) && !done.has(keyOf(i)))) : [];
  const liveKeys = live.map(keyOf);
  const selectedLive = live.find((item) => keyOf(item) === selected);
  // Without a selection, or one from an old link that is gone, the first item is selected.
  const fallback = !selectedLive && !(kept && keyOf(kept) === selected);
  useEffect(() => {
    if (inbox && fallback && live[0]) setSelected(keyOf(live[0]));
  }, [inbox, fallback, live[0] && keyOf(live[0])]);
  useEffect(() => {
    if (selectedLive) setKept(selectedLive);
  }, [selectedLive]);

  const resolved = !selectedLive && kept && keyOf(kept) === selected ? kept : null;
  // A resolved item stays in its place in the list.
  const shown = resolved
    ? (() => {
        const all = groups.flatMap((g) => [...live, resolved].filter((i) => g.kinds.includes(i.kind)));
        return all.filter((item, index) => all.findIndex((other) => keyOf(other) === keyOf(item)) === index);
      })()
    : live;
  const current = selectedLive ?? resolved ?? null;
  const arrived = useArrivals(liveKeys, inbox !== null);

  const select = useCallback((key: string | null, open = false) => {
    setSelected(key);
    setKept(null);
    setReopening(false);
    writeSelection(key);
    if (open) setDetailOpen(true);
  }, []);

  /** After acting on an item: the next one, or the previous when it was the last. */
  const actedOn = useCallback(
    (key: string) => {
      const keys = shown.map(keyOf);
      const at = keys.indexOf(key);
      const next = keys[at + 1] ?? keys[at - 1] ?? null;
      setDone((shownDone) => new Set([...shownDone, key]));
      select(next);
      reload();
    },
    [shown, select, reload],
  );

  const move = (by: number) => {
    const keys = shown.map(keyOf);
    const at = keys.indexOf(selected ?? "");
    const next = keys[Math.min(Math.max(at + by, 0), keys.length - 1)];
    if (next) select(next);
  };

  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});
  onKey.current = (event: KeyboardEvent) => {
    if (shortcutStandsAside(event)) return;
    const key = event.key.toLowerCase();
    if (key === "j") move(1);
    else if (key === "k") move(-1);
    else if (key === "a" && current?.kind === "question" && !resolved) answerBox.current?.textbox()?.focus();
    else if (key === "c" && current?.kind === "unverified" && !resolved) acceptRef.current?.();
    else if (key === "r" && current?.kind === "unverified" && !resolved) setReopening(true);
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  return (
    <div className="page">
      <PageHead crumbs={[workspaceCrumb(workspace)]} title="Inbox" switcher={<LiveIndicator workspaceId={workspace.id} />} />
      <FormError error={failure} />
      {inbox &&
        (shown.length === 0 ? (
          <EmptyState title="Nothing is waiting on you.">
            Questions from Agents, Runs gone wrong, and work to review or verify land here as they happen.
          </EmptyState>
        ) : (
          <>
            <div className={`inbox-split${detailOpen ? " inbox-detail-open" : ""}`}>
              <ul className="inbox-list" aria-label="Inbox">
                {groups.map((group) => {
                  const inGroup = shown.filter((item) => group.kinds.includes(item.kind));
                  if (inGroup.length === 0) return null;
                  return [
                    <li key={`group:${group.name}`} className="inbox-group" role="presentation">
                      {group.name} · {inGroup.length}
                    </li>,
                    ...inGroup.map((item) => {
                      const key = keyOf(item);
                      const isResolved = resolved !== null && key === keyOf(resolved);
                      const border = tone(item);
                      return (
                        <li
                          key={key}
                          aria-current={key === selected ? "true" : undefined}
                          className={`inbox-item${border ? ` inbox-item-${border}` : ""}${isResolved ? " inbox-item-resolved" : ""}${arrived.has(key) ? " arrived" : ""}`}
                        >
                          <button type="button" onClick={() => select(key, true)}>
                            <span className="inbox-item-head">
                              <KindLabel kind={kindOf(item)} />
                              <Key>{item.ticket.key}</Key>
                              <RelativeTime at={item.since} />
                            </span>
                            <span className="inbox-item-title">{item.ticket.title}</span>
                            <span className="inbox-item-snippet">{isResolved ? "Resolved elsewhere" : snippet(item)}</span>
                          </button>
                        </li>
                      );
                    }),
                  ];
                })}
              </ul>
              <section aria-label="Selected item" className="inbox-detail">
                <Button variant="ghost" className="inbox-back" onClick={() => setDetailOpen(false)}>
                  ← Inbox
                </Button>
                {current && (
                  <Detail
                    key={keyOf(current)}
                    item={current}
                    workspace={workspace}
                    user={user}
                    resolved={resolved !== null}
                    answerBox={answerBox}
                    acceptRef={acceptRef}
                    reopening={reopening}
                    onReopening={setReopening}
                    onActed={() => actedOn(keyOf(current))}
                  />
                )}
              </section>
            </div>
            <p className="muted small keys-line">
              <kbd>J</kbd> / <kbd>K</kbd> move through the list, <kbd>A</kbd> focuses the answer box, <kbd>C</kbd> Accepts and{" "}
              <kbd>R</kbd> opens Reopen…, on items that offer them.
            </p>
          </>
        ))}
    </div>
  );
}

/** Runs an item's action, keeping its error, and moves on once it succeeds. */
function useAction(onActed: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    action().then(
      () => {
        setBusy(false);
        onActed();
      },
      (e: Error) => {
        setBusy(false);
        setError(e.message);
      },
    );
  };
  return { busy, error, run };
}

/** The selected item: what happened, and its own actions. */
function Detail({
  item,
  workspace,
  user,
  resolved,
  answerBox,
  acceptRef,
  reopening,
  onReopening,
  onActed,
}: {
  item: InboxItem;
  workspace: Workspace;
  user: User;
  resolved: boolean;
  answerBox: RefObject<RichEditorHandle | null>;
  acceptRef: MutableRefObject<(() => void) | null>;
  reopening: boolean;
  onReopening: (open: boolean) => void;
  onActed: () => void;
}) {
  const to = useAddresses();
  const { busy, error, run } = useAction(onActed);
  const ticket = item.ticket;
  const disabled = busy || resolved;
  acceptRef.current = item.kind === "unverified" ? () => run(() => api.acceptTicket(ticket.id)) : null;
  return (
    <div className="detail">
      <p className="detail-head">
        <KindLabel kind={kindOf(item)} />
        <Link to={to.ticket(ticket)}>
          <Key>{ticket.key}</Key> {ticket.title}
        </Link>
      </p>
      {resolved && (
        <Banner tone="warn" label="Resolved elsewhere">
          <p>Resolved elsewhere: this no longer waits on you. Its actions are off; move on with J or K, or open its Ticket.</p>
        </Banner>
      )}
      <ItemBody item={item} workspace={workspace} user={user} disabled={disabled} run={run} answerBox={answerBox} />
      {item.kind === "unverified" && (
        <>
          <Actions>
            <Button variant="primary" disabled={disabled} onClick={() => acceptRef.current?.()}>
              Accept
            </Button>
            <Button disabled={disabled} onClick={() => onReopening(true)}>
              Reopen…
            </Button>
          </Actions>
          <Reopen ticketId={ticket.id} ticketKey={ticket.key} open={reopening} onOpenChange={onReopening} onReopened={onActed} />
        </>
      )}
      <FormError error={error} />
    </div>
  );
}

/** What each kind of item shows, and the actions it offers besides Accept and Reopen. */
function ItemBody({
  item,
  workspace,
  user,
  disabled,
  run,
  answerBox,
}: {
  item: InboxItem;
  workspace: Workspace;
  user: User;
  disabled: boolean;
  run: (action: () => Promise<unknown>) => void;
  answerBox: RefObject<RichEditorHandle | null>;
}) {
  const ticket = item.ticket;
  switch (item.kind) {
    case "question":
      return (
        <>
          <p className="detail-line">
            <Actor actor={{ kind: "agent", name: item.question.agent.name }} /> asks, from the {item.question.step.name} Step{" "}
            <RelativeTime at={item.question.askedAt} />
          </p>
          <div className="bubble bubble-question">
            <Markdown text={item.question.body} mentions={[]} />
          </div>
          <Answer item={item} disabled={disabled} run={run} answerBox={answerBox} />
        </>
      );
    case "needsYou":
      return (
        <>
          <p className="detail-line">{sentence(summary(item))}</p>
          {item.question && (
            <div className="bubble bubble-question">
              <p>Cronk asks: {item.question}</p>
            </div>
          )}
          <p className="muted small">Pick it up on its Ticket, or move it on to a Status with a Step.</p>
        </>
      );
    case "review":
      return (
        <>
          <p className="detail-line">{sentence(summary(item))}</p>
          <TicketStatus ticket={ticket} />
          <TicketPullRequests ticketId={ticket.id} workspaceId={workspace.id} />
          <LatestReport ticketId={ticket.id} workspaceId={workspace.id} />
        </>
      );
    case "unverified":
      return (
        <>
          <p className="detail-line">{sentence(summary(item))}</p>
          <LatestReport ticketId={ticket.id} workspaceId={workspace.id} />
        </>
      );
    case "run":
      return <RunGoneWrong item={item} disabled={disabled} run={run} />;
    case "discovered":
      return <Discovered item={item} workspace={workspace} user={user} disabled={disabled} run={run} />;
    case "reassign":
      return <Reassign item={item} workspace={workspace} disabled={disabled} run={run} />;
  }
}

/** The answer box under a Question: the answer is a reply to it, which sends the Ticket back to the Step that asked. */
function Answer({
  item,
  disabled,
  run,
  answerBox,
}: {
  item: Extract<InboxItem, { kind: "question" }>;
  disabled: boolean;
  run: (action: () => Promise<unknown>) => void;
  answerBox: RefObject<RichEditorHandle | null>;
}) {
  const [body, setBody] = useState("");
  return (
    <form
      className="comment-form"
      onSubmit={(event) => {
        event.preventDefault();
        // An empty box answers nothing.
        if (body !== "") run(() => api.comment(item.ticket.id, { body, replyToId: item.question.commentId }));
      }}
    >
      <RichEditor
        label="Answer"
        compact
        submitOnCtrlOrCmdEnter
        placeholder={`Answer ${item.question.agent.name}…`}
        value={body}
        disabled={disabled}
        onChange={setBody}
        handle={answerBox}
      />
      <Actions>
        <CommentButton variant="primary" disabled={disabled}>
          Post answer
        </CommentButton>
        <span className="muted small">The answer sends {item.ticket.key} back to the {item.question.step.name} Step.</span>
        <Button variant="ghost" disabled={disabled} onClick={() => run(() => api.dismissQuestion(item.question.id))}>
          Dismiss
        </Button>
      </Actions>
    </form>
  );
}

/** Asks for the required Comment saying why, then Reopens the Ticket. */
function Reopen({
  ticketId,
  ticketKey,
  open,
  onOpenChange,
  onReopened,
}: {
  ticketId: string;
  ticketKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReopened: () => void;
}) {
  const [why, setWhy] = useState("");
  const { error, busy, onSubmit } = useSubmit(async () => {
    await api.reopenTicket(ticketId, why);
    onOpenChange(false);
    setWhy("");
    onReopened();
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Reopen ${ticketKey}`} description="It goes back to the Step that completed it, with your Comment.">
      <form onSubmit={onSubmit}>
        <RichEditor label="Why reopen it?" compact autoFocus value={why} onChange={setWhy} />
        <FormError error={error} />
        <DialogActions>
          <DialogClose asChild>
            <Button>Cancel</Button>
          </DialogClose>
          <Button type="submit" variant="primary" disabled={busy || why.trim() === ""}>
            Reopen
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

/** The Ticket's latest Report, rendered inline, if it has one; fetched again after each live event, like the Inbox. */
function LatestReport({ ticketId, workspaceId }: { ticketId: string; workspaceId: string }) {
  const to = useAddresses();
  const [report, setReport] = useState<Report | null>(null);
  const latest = useLatest();
  const load = useCallback(
    () => latest(api.reports(ticketId), (all) => setReport(all.at(-1) ?? null), () => setReport(null)),
    [ticketId, latest],
  );
  useEffect(load, [load]);
  useLiveEvents(workspaceId, load);
  if (!report) return null;
  return (
    <div className="report-card">
      <header className="report-card-head">
        <h3>
          <KindLabel kind="Report" /> <Link to={to.document(report)}>{report.title}</Link>
        </h3>
        <Actor actor={{ kind: "agent", name: report.agent.name }} />
      </header>
      <div className="markdown-compact">
        <Markdown text={report.body} mentions={[]} />
      </div>
    </div>
  );
}

/** The Ticket's Pull Requests, as rows, if it has any; fetched again after each live event, like the Inbox. */
function TicketPullRequests({ ticketId, workspaceId }: { ticketId: string; workspaceId: string }) {
  const [pullRequests, setPullRequests] = useState<PullRequest[]>([]);
  const latest = useLatest();
  const load = useCallback(() => latest(api.pullRequests(ticketId), setPullRequests, () => setPullRequests([])), [ticketId, latest]);
  useEffect(load, [load]);
  useLiveEvents(workspaceId, load);
  return <PullRequestRows pullRequests={pullRequests} />;
}

/** The Ticket's Status, as a pill. */
function TicketStatus({ ticket }: { ticket: InboxItem["ticket"] }) {
  const project = useProject(ticket.projectId);
  const status = project?.statuses.find((s) => s.id === ticket.statusId);
  return status ? (
    <p className="detail-line">
      Status <StatusPill kind={status.kind} name={status.name} model={status.step?.model} />
    </p>
  ) : null;
}

function useProject(projectId: string): Project | null {
  const [project, setProject] = useState<Project | null>(null);
  useEffect(() => {
    api.project(projectId).then(setProject, () => setProject(null));
  }, [projectId]);
  return project;
}

/** A Run that went wrong: what happened and why, its session, and Retry, which starts a fresh Run of the same Step. */
function RunGoneWrong({
  item,
  disabled,
  run,
}: {
  item: Extract<InboxItem, { kind: "run" }>;
  disabled: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const [found, setFound] = useState<Run | null>(null);
  useEffect(() => {
    api.runs(item.ticket.id).then((runs) => setFound(runs.find((r) => r.id === item.run.id) ?? null), () => {});
  }, [item.ticket.id, item.run.id]);
  return (
    <>
      <p className="detail-line">
        <RunState state={item.run.state} /> {sentence(summary(item))}
      </p>
      {found && (
        <p className="detail-line">
          <Actor actor={{ kind: "agent", name: found.agent.name }} /> ran it on <span className="model-label">{found.model}</span>, started{" "}
          <RelativeTime at={found.startedAt} />
          {found.sessionUrl && (
            <>
              {" · "}
              <a href={found.sessionUrl} target="_blank" rel="noreferrer">
                Session
              </a>
            </>
          )}
        </p>
      )}
      <Actions>
        <Button variant="primary" disabled={disabled} onClick={() => run(() => api.retry(item.ticket.id))} aria-label={`Retry ${item.ticket.key}`}>
          Retry
        </Button>
      </Actions>
    </>
  );
}

/** A Discovered Ticket an Agent filed: Delegate it to one of the User's Agents, Move… it, or Dismiss it. */
function Discovered({
  item,
  workspace,
  user,
  disabled,
  run,
}: {
  item: Extract<InboxItem, { kind: "discovered" }>;
  workspace: Workspace;
  user: User;
  disabled: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const to = useAddresses();
  const source = item.ticket.discovered?.sourceTicket;
  const [agents, setAgents] = useState<Agent[]>([]);
  const [moving, setMoving] = useState(false);
  const project = useProject(item.ticket.projectId);
  useEffect(() => {
    api.agents(workspace.id).then(setAgents, () => setAgents([]));
  }, [workspace.id]);
  const own = agents.filter((a) => a.owner.id === user.id);
  const [chosen, setChosen] = useState("");
  const delegate = own.find((a) => a.id === chosen) ?? own[0];
  return (
    <>
      <p className="detail-line">
        Discovered by <Actor actor={{ kind: "agent", name: item.agent.name }} />
        {source && (
          <>
            {" "}
            while on <Link to={to.ticket(source)}>{source.key}</Link>
          </>
        )}
        : delegate, move or dismiss it.
      </p>
      {item.ticket.description && (
        <div className="bubble">
          <Markdown text={item.ticket.description} mentions={[]} />
        </div>
      )}
      <Actions>
        {own.length > 1 && (
          <select aria-label="Agent to delegate to" value={delegate?.id} onChange={(e) => setChosen(e.target.value)} className="inline-select">
            {own.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        )}
        <Button
          variant="primary"
          disabled={disabled || !delegate}
          title={delegate ? undefined : "You have no Agent in this Workspace to delegate to"}
          onClick={() => delegate && run(() => api.editTicket(item.ticket.id, { delegateId: delegate.id }))}
        >
          Delegate{delegate && own.length === 1 ? ` to ${delegate.name}` : ""}
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={() => setMoving(true)}>
          Move…
        </Button>
        <Button variant="ghost" disabled={disabled} onClick={() => run(() => api.dismiss(item.ticket.id))} aria-label={`Dismiss ${item.ticket.key}`}>
          Dismiss
        </Button>
      </Actions>
      <Dialog open={moving} onOpenChange={setMoving} title={`Move ${item.ticket.key}`} description="To another Status of its Project.">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const statusId = field(new FormData(event.currentTarget), "statusId");
            setMoving(false);
            run(() => api.editTicket(item.ticket.id, { statusId }));
          }}
        >
          <Field label="Status">
            <select name="statusId" defaultValue={item.ticket.statusId}>
              {project?.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <DialogActions>
            <DialogClose asChild>
              <Button>Cancel</Button>
            </DialogClose>
            <Button type="submit" variant="primary">
              Move
            </Button>
          </DialogActions>
        </form>
      </Dialog>
    </>
  );
}

/** A Ticket whose Assignee left the Workspace, to assign to someone. */
function Reassign({
  item,
  workspace,
  disabled,
  run,
}: {
  item: Extract<InboxItem, { kind: "reassign" }>;
  workspace: Workspace;
  disabled: boolean;
  run: (action: () => Promise<unknown>) => void;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => {
    api.members(workspace.id).then(setMembers, () => setMembers([]));
  }, [workspace.id]);
  return (
    <>
      <p className="detail-line">{sentence(summary(item))}</p>
      <FieldPicker
        label="Assignee"
        value={<span className="muted">Nobody</span>}
        options={members.map(({ user }) => ({ value: user.id, label: nameOf(user), content: <Actor actor={{ kind: "user", name: nameOf(user) }} /> }))}
        selected={[]}
        disabled={disabled}
        onPick={(assigneeId) => run(() => api.editTicket(item.ticket.id, { assigneeId }))}
      />
    </>
  );
}

