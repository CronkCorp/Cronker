import { Type, type Static } from "typebox";

export const ComparedLine = Type.Object({
  change: Type.Union([Type.Literal("same"), Type.Literal("removed"), Type.Literal("added")], {
    description: "Whether the line is in both texts, only the earlier one, or only the later one.",
  }),
  text: Type.String(),
});
export type ComparedLine = Static<typeof ComparedLine>;

/** Beyond this many cells, the middle of two texts compares as wholly removed and wholly added. */
const cellLimit = 4_000_000;

/**
 * Two texts compared line by line: the lines both keep, in order, as many as possible, with what one removed
 * and the other added between them, removals first.
 */
export function compareLines(before: string, after: string): ComparedLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const same = (text: string): ComparedLine => ({ change: "same", text });
  const middle = middleOf(a.slice(start, endA), b.slice(start, endB));
  return [...a.slice(0, start).map(same), ...middle, ...a.slice(endA).map(same)];
}

/** The longest common subsequence of lines, as a table of suffix lengths, walked from the start. */
function middleOf(a: string[], b: string[]): ComparedLine[] {
  const removed = (text: string): ComparedLine => ({ change: "removed", text });
  const added = (text: string): ComparedLine => ({ change: "added", text });
  if ((a.length + 1) * (b.length + 1) > cellLimit) return [...a.map(removed), ...b.map(added)];
  const width = b.length + 1;
  const common = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i * width + j] =
        a[i] === b[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
  }
  const lines: ComparedLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push({ change: "same", text: a[i]! });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && common[(i + 1) * width + j]! >= common[i * width + j + 1]!)) {
      lines.push(removed(a[i++]!));
    } else {
      lines.push(added(b[j++]!));
    }
  }
  return lines;
}
