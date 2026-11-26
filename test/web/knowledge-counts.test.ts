import { describe, expect, it } from "vitest";
import type { Inbox, InboxItem } from "../../web/src/api.js";
import { knowledgeCounts } from "../../web/src/knowledge-counts.js";

const knowledge = (kind: string, projectId: string | null) =>
  ({
    kind: "knowledge",
    id: `${kind}-${projectId}`,
    subject: { kind, projectId },
  }) as unknown as InboxItem;
const ticketItem = (kind: InboxItem["kind"], projectId: string) =>
  ({ kind, ticket: { id: "t", projectId } }) as unknown as InboxItem;

describe("knowledgeCounts", () => {
  const inbox = {
    items: [
      knowledge("document", "p1"),
      knowledge("document", "p1"),
      knowledge("decision", "p1"),
      knowledge("term", "p2"),
      knowledge("artifact", null),
      knowledge("term", null),
      ticketItem("review", "p1"),
      ticketItem("discovered", "p1"),
    ],
  } as Pick<Inbox, "items">;

  it("counts a Project's New knowledge by kind, leaving out other Projects', the Workspace's and Tickets", () => {
    expect(knowledgeCounts(inbox, "p1")).toEqual({
      document: 2,
      term: 0,
      decision: 1,
      artifact: 0,
    });
  });

  it("counts only the Workspace's own knowledge for the Workspace", () => {
    expect(knowledgeCounts(inbox, null)).toEqual({
      document: 0,
      term: 1,
      decision: 0,
      artifact: 1,
    });
  });

  it("counts nothing while the Inbox loads", () => {
    expect(knowledgeCounts(null, "p1")).toEqual({
      document: 0,
      term: 0,
      decision: 0,
      artifact: 0,
    });
  });
});
