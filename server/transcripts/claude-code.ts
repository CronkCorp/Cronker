import type { ConvertedEntry } from "./transcripts.js";
import { isObject, resultText, timeOf } from "./converting.js";

/**
 * The converter for Claude Code's JSONL transcripts, as the Transcript hook uploads them: one JSON object a line,
 * `user` and `assistant` lines carrying an API message, `system` lines a notice, and others (summaries, file
 * snapshots) Cronk has no use for. A message's text blocks become entries of their own; a tool call becomes one
 * entry, and the tool result a later `user` line carries for it is added to that entry. Thinking is left out, and
 * so is a line that isn't JSON, such as the last line of a file still being written.
 */
export function convertClaudeCode(jsonl: string): ConvertedEntry[] {
  const entries: ConvertedEntry[] = [];
  const calls = new Map<string, ConvertedEntry>();
  const entry = (role: ConvertedEntry["role"], at: string | null, fields: Partial<ConvertedEntry>): ConvertedEntry => {
    const added = { role, text: null, toolName: null, toolInput: null, toolResult: null, at, ...fields };
    entries.push(added);
    return added;
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const at = timeOf(parsed.timestamp);
    if (parsed.type === "system") {
      if (typeof parsed.content === "string" && parsed.content.trim()) entry("system", at, { text: parsed.content });
      continue;
    }
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    const role = parsed.type;
    const content = isObject(parsed.message) ? parsed.message.content : undefined;
    if (typeof content === "string") {
      if (content.trim()) entry(role, at, { text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        entry(role, at, { text: block.text });
      } else if (block.type === "tool_use" && typeof block.name === "string") {
        const call = entry(role, at, { toolName: block.name, toolInput: block.input ?? null });
        if (typeof block.id === "string") calls.set(block.id, call);
      } else if (block.type === "tool_result") {
        const result = resultText(block.content);
        const call = typeof block.tool_use_id === "string" ? calls.get(block.tool_use_id) : undefined;
        if (call) call.toolResult = result;
        else entry(role, at, { toolResult: result });
      }
    }
  }
  return entries;
}
