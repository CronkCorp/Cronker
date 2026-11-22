// The Live invalidation table (seam 10): which loaded data each event of a Workspace's stream makes stale.
import type { QueryKey } from "@tanstack/react-query";
import { expect, test } from "vitest";
import { liveEventTypes } from "../../server/live/live.js";
import type { StreamEvent } from "../../web/src/live.js";
import { invalidations, keys } from "../../web/src/live-queries.js";

const p = "project-1";
const t = "ticket-1";

/** One event of each type the stream tells, two where a type comes in two shapes; the type check keeps it complete. */
const samples: { [type in StreamEvent["type"]]: Extract<StreamEvent, { type: type }>[] } = {
  reconnected: [{ type: "reconnected" }],
  "project.created": [{ type: "project.created", projectId: p }],
  "project.changed": [{ type: "project.changed", projectId: p }],
  "project.gained": [{ type: "project.gained", projectId: p }],
  "project.lost": [{ type: "project.lost", projectId: p }],
  "statuses.changed": [{ type: "statuses.changed", projectId: p }],
  "ticket.created": [{ type: "ticket.created", projectId: p, ticketId: t }],
  "ticket.changed": [{ type: "ticket.changed", projectId: p, ticketId: t }],
  "comment.added": [{ type: "comment.added", projectId: p, ticketId: t, commentId: "comment-1" }],
  "report.added": [{ type: "report.added", projectId: p, ticketId: t, reportId: "report-1" }],
  "report.changed": [{ type: "report.changed", projectId: p, ticketId: t, reportId: "report-1" }],
  "attachments.changed": [
    { type: "attachments.changed", projectId: p, ticketId: t },
    { type: "attachments.changed", documentId: "report-1" },
  ],
  "pull_requests.changed": [{ type: "pull_requests.changed", projectId: p, ticketId: t }],
  "transcripts.changed": [{ type: "transcripts.changed", projectId: p, ticketId: t }],
  "document.changed": [{ type: "document.changed", projectId: null, documentId: "document-1" }],
  "term.changed": [{ type: "term.changed", projectId: p, termId: "term-1" }],
  "decision.changed": [{ type: "decision.changed", projectId: null, decisionId: "decision-1" }],
  "artifact.changed": [{ type: "artifact.changed", projectId: p, artifactId: "artifact-1" }],
  "artifact.comments.changed": [{ type: "artifact.comments.changed", projectId: p, artifactId: "artifact-1" }],
  "transcript.changed": [{ type: "transcript.changed", transcriptId: "transcript-1", runId: null }],
};

/** Whether invalidating `key` makes `loaded` stale, as `invalidateQueries` matches: by prefix. */
const covers = (key: QueryKey, loaded: QueryKey) => key.every((part, i) => part === loaded[i]);
const stale = (event: StreamEvent, loaded: QueryKey) => invalidations(event).some((key) => covers(key, loaded));

test("the samples hold every event type the server sends", () => {
  expect(Object.keys(samples).sort()).toEqual([...Object.keys(liveEventTypes), "reconnected"].sort());
});

test.each(Object.values(samples).flat().map((event) => [event.type, event] as const))(
  "%s invalidates something",
  (_type, event) => {
    expect(invalidations(event).length).toBeGreaterThan(0);
  },
);

test("an event type with no entry fails", () => {
  expect(() => invalidations({ type: "ticket.renamed" } as unknown as StreamEvent)).toThrow(/No Live invalidation for ticket\.renamed/);
});

test("a reconnect makes everything stale", () => {
  for (const loaded of [keys.ticket(t), keys.project(p), keys.members("workspace-1"), keys.documentAttachments("report-1")]) {
    expect(stale({ type: "reconnected" }, loaded)).toBe(true);
  }
});

test("a Ticket's change refreshes what its screen shows of it, and only that Ticket's", () => {
  const changed = samples["ticket.changed"][0]!;
  for (const loaded of [
    keys.ticket(t),
    keys.timeline(t),
    keys.runs(t),
    keys.transcripts(t),
    keys.relations(t),
    keys.documentLinks(t),
    keys.artifactLinks(t),
    // Linking or unlinking an Artifact brings its Comments onto the timeline, or takes them off.
    keys.comments(t),
    keys.projectTickets(p),
  ]) {
    expect(stale(changed, loaded), loaded.join(" ")).toBe(true);
  }
  expect(stale(changed, keys.ticket("ticket-2"))).toBe(false);
  expect(stale(changed, keys.projectTickets("project-2"))).toBe(false);
});

test("each event of a Ticket refreshes the part it names", () => {
  expect(stale(samples["comment.added"][0]!, keys.comments(t))).toBe(true);
  expect(stale(samples["report.added"][0]!, keys.reports(t))).toBe(true);
  expect(stale(samples["report.changed"][0]!, keys.documentAttachments("report-1"))).toBe(true);
  expect(stale(samples["pull_requests.changed"][0]!, keys.pullRequests(t))).toBe(true);
  expect(stale(samples["transcripts.changed"][0]!, keys.transcripts(t))).toBe(true);
  expect(stale(samples["ticket.created"][0]!, keys.projectTickets(p))).toBe(true);
  expect(stale(samples["statuses.changed"][0]!, keys.project(p))).toBe(true);
  expect(stale(samples["comment.added"][0]!, keys.ticket(t))).toBe(false);
});

test("a Ticket's files changing refreshes its Attachments and its Comments, which carry theirs; a Report's, its Document's", () => {
  const [ticketFiles, documentFiles] = samples["attachments.changed"];
  expect(stale(ticketFiles!, keys.attachments(t))).toBe(true);
  expect(stale(ticketFiles!, keys.comments(t))).toBe(true);
  expect(stale(documentFiles!, keys.documentAttachments("report-1"))).toBe(true);
  expect(stale(documentFiles!, keys.attachments(t))).toBe(false);
});

test("the board's events refresh its Project and each filter's list of its Tickets, and only that Project's", () => {
  const filtered = [...keys.projectTickets(p), { priority: "high" }];
  const elsewhere = [...keys.projectTickets("project-2"), { priority: "high" }];
  for (const type of ["ticket.created", "ticket.changed"] as const) {
    const event = samples[type][0]!;
    expect(stale(event, keys.projectTickets(p)), type).toBe(true);
    expect(stale(event, filtered), type).toBe(true);
    expect(stale(event, elsewhere), type).toBe(false);
  }
  for (const type of ["statuses.changed", "project.changed"] as const) {
    const event = samples[type][0]!;
    expect(stale(event, keys.project(p)), type).toBe(true);
    expect(stale(event, keys.project("project-2")), type).toBe(false);
  }
  expect(stale({ type: "reconnected" }, filtered)).toBe(true);
});
