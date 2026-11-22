// The web client takes every response type from the server (CRONK-50), so a schema built from a runtime list must
// type its `Static` as the list's literals: `Type.Union` of a mapped array types it as `never`, against which the web
// client's code checks nothing. These checks run in the type check; the test itself only has to load.
import { expectTypeOf, test } from "vitest";
import type { Check, PullRequest } from "../../web/src/api.js";
import type { Change, DecisionStatus, Run, RunState, SearchKind, SearchResult, Status, StatusKind } from "../../web/src/api.js";

test("response types built from runtime lists keep their literals", () => {
  expectTypeOf<Run["state"]>().toEqualTypeOf<RunState>();
  expectTypeOf<RunState>().not.toBeNever();
  expectTypeOf<"running">().toExtend<RunState>();
  expectTypeOf<Status["kind"]>().toEqualTypeOf<StatusKind>();
  expectTypeOf<StatusKind>().toEqualTypeOf<"backlog" | "active" | "review" | "done" | "canceled">();
  expectTypeOf<Check["state"]>().toEqualTypeOf<"pending" | "passed" | "failed" | "neutral">();
  expectTypeOf<PullRequest["state"]>().toEqualTypeOf<"open" | "draft" | "merged" | "closed">();
  expectTypeOf<NonNullable<PullRequest["reviewState"]>["state"]>().toEqualTypeOf<"approved" | "changes_requested">();
  expectTypeOf<SearchResult["kind"]>().toEqualTypeOf<SearchKind>();
  expectTypeOf<SearchKind>().not.toBeNever();
  expectTypeOf<Change["field"]>().not.toBeNever();
  expectTypeOf<"title">().toExtend<Change["field"]>();
  expectTypeOf<DecisionStatus>().toEqualTypeOf<"proposed" | "accepted" | "rejected" | "deprecated" | "superseded">();
});
