import type { ConvertedEntry } from "./transcripts.js";
import { isObject, resultText, timeOf } from "./converting.js";

/**
 * The converter for OpenCode's events, as `opencode run --format json` prints them and the daemon records them for a
 * Run on a Machine model: one JSON object a line, each with its `type`, `timestamp` (milliseconds) and `sessionID`.
 *
 * - A `text` event's part is the agent's message, an `assistant` entry.
 * - A `tool_use` event's part is a tool call: its `tool`, and a `state` with its `input` and, once it ended, its
 *   `output` or its `error`. An errored call, a denied one included, keeps its error as its result, marked as one. A
 *   call printed more than once, such as pending and then completed, is one entry, kept up to date by its `callID`.
 * - An `error` event, such as the model's server failing, is a `system` entry with its message.
 * - Reasoning, steps' starts and finishes, events of any other type, and a line that isn't JSON, such as the last line
 *   of a file still being written, are left out.
 */
export function convertOpenCode(jsonl: string): ConvertedEntry[] {
  const entries: ConvertedEntry[] = [];
  const calls = new Map<string, ConvertedEntry>();
  const entry = (role: ConvertedEntry["role"], at: string | null, fields: Partial<ConvertedEntry>): ConvertedEntry => {
    const added = { role, text: null, toolName: null, toolInput: null, toolResult: null, at, ...fields };
    entries.push(added);
    return added;
  };

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(event)) continue;
    const part = isObject(event.part) ? event.part : {};
    const at = timeOfEvent(event.timestamp);

    if (event.type === "text") {
      if (typeof part.text === "string" && part.text.trim()) entry("assistant", at, { text: part.text });
    } else if (event.type === "tool_use") {
      if (typeof part.tool !== "string" || !part.tool) continue;
      const state = isObject(part.state) ? part.state : {};
      const fields: Partial<ConvertedEntry> = { toolName: part.tool, toolInput: state.input ?? null, toolResult: resultOf(state) };
      const id = typeof part.callID === "string" ? part.callID : typeof part.id === "string" ? part.id : null;
      const known = id ? calls.get(id) : undefined;
      if (known) {
        Object.assign(known, {
          toolInput: fields.toolInput ?? known.toolInput,
          toolResult: fields.toolResult ?? known.toolResult,
        });
      } else {
        const call = entry("assistant", at, fields);
        if (id) calls.set(id, call);
      }
    } else if (event.type === "error") {
      const text = errorText(event.error);
      if (text) entry("system", at, { text });
    }
  }
  return entries;
}

/** A tool call's result: its output once completed, its error marked as one once errored, and null before. */
function resultOf(state: Record<string, unknown>): string | null {
  if (state.status === "error" || (state.error !== undefined && state.error !== null)) {
    const text = errorText(state.error);
    return `Error: ${text || "the tool call failed"}`;
  }
  if (state.output === undefined || state.output === null) return null;
  return resultText(state.output);
}

/** An error's message, from a string, an `{ message }` or an `{ name, data: { message } }` as OpenCode gives them. */
function errorText(error: unknown): string {
  if (typeof error === "string") return error.trim();
  if (!isObject(error)) return "";
  const data = isObject(error.data) ? error.data : {};
  const message = [data.message, error.message].find((value) => typeof value === "string" && value.trim());
  if (typeof message === "string") return message.trim();
  return typeof error.name === "string" ? error.name : "";
}

/** An event's time, given in milliseconds since the epoch, or as an ISO string. */
function timeOfEvent(value: unknown): string | null {
  if (typeof value === "number") {
    const time = new Date(value);
    return Number.isNaN(time.getTime()) ? null : time.toISOString();
  }
  return timeOf(value);
}
