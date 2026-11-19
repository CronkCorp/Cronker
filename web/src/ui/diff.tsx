import type { ReactNode } from "react";

export interface DiffLine {
  change: "same" | "removed" | "added";
  text: string;
}

/**
 * The lines that changed from one text to another, for showing a saved Version against a draft; Cronk compares
 * two saved Versions itself.
 */
export function lineDiff(from: string, to: string): DiffLine[] {
  const a = from.split("\n");
  const b = to.split("\n");
  // The longest common subsequence of lines, by dynamic programming from the end.
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ change: "same", text: a[i]! });
      i++;
      j++;
    } else if (common[i + 1]![j]! >= common[i]![j + 1]!) {
      lines.push({ change: "removed", text: a[i++]! });
    } else {
      lines.push({ change: "added", text: b[j++]! });
    }
  }
  while (i < a.length) lines.push({ change: "removed", text: a[i++]! });
  while (j < b.length) lines.push({ change: "added", text: b[j++]! });
  return lines;
}

/** Two texts' lines: removed struck through on red, added on green, under a header naming both sides. */
export function Diff({ from, to, lines, label }: { from: ReactNode; to: ReactNode; lines: DiffLine[]; label?: string }) {
  return (
    <section className="diff" aria-label={label ?? "Comparison"}>
      <header className="diff-head">
        <span>{from}</span>
        <span aria-hidden="true">→</span>
        <span>{to}</span>
      </header>
      <div className="diff-lines">
        {lines.map((line, index) => (
          <div key={index} className={`diff-line diff-${line.change}`}>
            <span className="diff-sign" aria-hidden="true">
              {line.change === "added" ? "+" : line.change === "removed" ? "−" : " "}
            </span>
            {line.change === "removed" ? <del>{line.text || " "}</del> : line.change === "added" ? <ins>{line.text || " "}</ins> : line.text || " "}
          </div>
        ))}
      </div>
    </section>
  );
}
