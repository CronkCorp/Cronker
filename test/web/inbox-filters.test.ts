import { describe, expect, it } from "vitest";
import type { InboxItem } from "../../web/src/api.js";
import { filtering, matches, noFilters, projectOf, readFilters, withFilters } from "../../web/src/inbox-filters.js";

const item = (kind: InboxItem["kind"], key: string, projectId: string | null = "p1") =>
  ({ kind, ticket: { id: `t-${key}`, key, projectId, title: key } }) as unknown as InboxItem;

describe("readFilters", () => {
  it("reads repeated and comma-separated Projects and kinds, each once", () => {
    expect(readFilters("?project=cronk&project=WEB,cronk&kind=question,needs-you&kind=question")).toEqual({
      projects: ["CRONK", "WEB"],
      kinds: ["question", "needs-you"],
    });
  });

  it("ignores kinds the Inbox doesn't have, and reads the Workspace option in any case", () => {
    expect(readFilters("?kind=bogus&kind=Unverified&project=Workspace")).toEqual({ projects: ["workspace"], kinds: ["unverified"] });
  });

  it("reads no filters from an address without them", () => {
    expect(readFilters("?item=question:1")).toEqual(noFilters);
    expect(filtering(readFilters("?item=question:1"))).toBe(false);
  });
});

describe("withFilters", () => {
  it("replaces the filters and keeps the selection", () => {
    const search = withFilters("?item=review%3At1&project=OLD", { projects: ["CRONK", "WEB"], kinds: ["run"] });
    expect(new URLSearchParams(search).get("item")).toBe("review:t1");
    expect(readFilters(search)).toEqual({ projects: ["CRONK", "WEB"], kinds: ["run"] });
    expect(withFilters(search, noFilters)).toBe("item=review%3At1");
  });
});

describe("matches", () => {
  it("shows an item in one of the chosen Projects and of one of the chosen kinds", () => {
    const filters = { projects: ["CRONK"], kinds: ["needs-you", "unverified"] };
    expect(matches(item("reassign", "CRONK-4"), filters)).toBe(true);
    expect(matches(item("unverified", "CRONK-12"), filters)).toBe(true);
    expect(matches(item("question", "CRONK-4"), filters)).toBe(false);
    expect(matches(item("unverified", "WEB-1"), filters)).toBe(false);
  });

  it("shows everything without filters", () => {
    expect(matches(item("discovered", "WEB-1"), noFilters)).toBe(true);
  });

  it("puts an item of no Project under the Workspace option", () => {
    expect(projectOf(item("review", "K2-3"))).toBe("K2");
    expect(projectOf(item("review", "X-1", null))).toBe("workspace");
    expect(matches(item("review", "X-1", null), { projects: ["workspace"], kinds: [] })).toBe(true);
  });
});
