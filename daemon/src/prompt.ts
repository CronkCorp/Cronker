import { createInterface, type Interface } from "node:readline";

/**
 * Questions asked in the terminal, one line each, from one reader so answers piped in all arrive. A hidden question,
 * such as a key's, doesn't echo what is typed.
 */
export function asker(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout) {
  let reader: Interface | undefined;
  let muted = false;
  const lines: string[] = [];
  const waiting: ((line: string | null) => void)[] = [];
  let ended = false;
  const open = (): Interface => {
    if (reader) return reader;
    reader = createInterface({ input, output, terminal: (input as { isTTY?: boolean }).isTTY === true });
    // While muted, nothing typed is echoed: only the question itself was written before muting.
    const write = (reader as unknown as { _writeToOutput: (text: string) => void })._writeToOutput.bind(reader);
    (reader as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (!muted) write(text);
    };
    reader.on("line", (line) => {
      const next = waiting.shift();
      if (next) next(line);
      else lines.push(line);
    });
    reader.on("close", () => {
      ended = true;
      for (const next of waiting.splice(0)) next(null);
    });
    return reader;
  };
  return {
    async ask(question: string, options: { hidden?: boolean } = {}): Promise<string> {
      open();
      output.write(question);
      muted = options.hidden === true;
      try {
        const line =
          lines.length > 0 ? lines.shift()! : ended ? null : await new Promise<string | null>((resolve) => waiting.push(resolve));
        if (line === null) throw new Error(`No answer to "${question.trim()}": the input ended.`);
        return line;
      } finally {
        if (muted) output.write("\n");
        muted = false;
      }
    },
    close(): void {
      reader?.close();
    },
  };
}
