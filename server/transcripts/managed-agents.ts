import type { AppendedEntries } from "./transcripts.js";
import { isObject, resultText, timeOf } from "./converting.js";

/**
 * The converter for a Managed Agents session's events, as Cronk fetches them a page at a time: `user.message` and
 * `agent.message` events become an entry for each of their text blocks; a tool call (`agent.tool_use`,
 * `agent.mcp_tool_use`, `agent.custom_tool_use`) becomes one entry, named as Claude Code names it (`mcp__cronk__…`
 * for Cronk's own tools), and the result a later event carries for it is added to that entry; `user.interrupt` and
 * `session.error` become a system entry each. Status changes, spans, thinking (which carries no content) and usage
 * are left out.
 *
 * Events come in batches, and a result may come in a later batch than its call: one whose call isn't in this batch is
 * returned with the call's event id, for the Transcript to add to the entry stored for it.
 */
export function convertManagedAgentsEvents(events: unknown[]): AppendedEntries {
  const appended: AppendedEntries = { entries: [], results: [] };
  const calls = new Map<string, AppendedEntries["entries"][number]>();
  const entry = (role: "user" | "assistant" | "system", at: string | null, fields: Partial<AppendedEntries["entries"][number]>) => {
    const added = { role, text: null, toolName: null, toolInput: null, toolResult: null, at, callId: null, ...fields };
    appended.entries.push(added);
    return added;
  };

  for (const event of events) {
    if (!isObject(event) || typeof event.type !== "string") continue;
    const at = timeOf(event.processed_at);
    const id = typeof event.id === "string" ? event.id : null;
    switch (event.type) {
      case "user.message":
      case "agent.message": {
        const role = event.type === "user.message" ? "user" : "assistant";
        for (const text of textsOf(event.content)) entry(role, at, { text });
        break;
      }
      case "agent.tool_use":
      case "agent.custom_tool_use":
      case "agent.mcp_tool_use": {
        if (typeof event.name !== "string") break;
        const server = event.type === "agent.mcp_tool_use" && typeof event.mcp_server_name === "string" ? event.mcp_server_name : null;
        const call = entry("assistant", at, {
          toolName: server ? `mcp__${server}__${event.name}` : event.name,
          toolInput: event.input ?? null,
          callId: id,
        });
        if (id) calls.set(id, call);
        break;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result":
      case "user.custom_tool_result": {
        const callId = [event.tool_use_id, event.mcp_tool_use_id, event.custom_tool_use_id].find((v) => typeof v === "string") as
          | string
          | undefined;
        const result = resultText(event.content);
        const call = callId ? calls.get(callId) : undefined;
        if (call) call.toolResult = result;
        else if (callId) appended.results.push({ callId, toolResult: result });
        else entry(event.type === "user.custom_tool_result" ? "user" : "assistant", at, { toolResult: result });
        break;
      }
      case "user.interrupt":
        entry("system", at, { text: "The session was interrupted." });
        break;
      case "session.error": {
        const message = isObject(event.error) && typeof event.error.message === "string" ? event.error.message : null;
        entry("system", at, { text: message ? `The session met an error: ${message}` : "The session met an error." });
        break;
      }
    }
  }
  return appended;
}

/** A message's non-blank text blocks. */
function textsOf(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    isObject(block) && block.type === "text" && typeof block.text === "string" && block.text.trim() ? [block.text] : [],
  );
}
