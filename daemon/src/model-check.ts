import { randomBytes } from "node:crypto";
import type { MachineModel } from "./config.js";

/**
 * The checks `cronk-runner model add` makes before saving a Machine model, so that a server that can't do a Run is
 * found then rather than mid-Run: one request asking for a tool call, and one with a marker at the start of a prompt
 * close to the context size, asking for it back. Ollama, for one, silently loads a 4,096 context and drops the start of
 * a longer prompt, so the marker is lost.
 */

export type CheckName = "reachable" | "tools" | "context";

export interface CheckFailure {
  check: CheckName;
  /** What failed, with the server's own message when it gave one. */
  what: string;
  /** How to put it right. */
  fix: string;
}

export interface CheckOptions {
  /** How long the tool call may take; a minute when left out. */
  toolsTimeoutMs?: number;
  /** How long the long prompt may take, which a local server reads slowly; five minutes when left out. */
  contextTimeoutMs?: number;
  /** Told before the long request, which can take minutes. */
  note?: (line: string) => void;
}

/** How much of the context size the long prompt fills, leaving room for the instructions and the answer. */
const contextShare = 0.85;
/** Words that each cost one token in the tokenizers in use, so the prompt's size in tokens is about its word count. */
const fillerWords = "the cat sat on the mat and the dog ran to the park in the sun".split(" ");

/** Ways to put each failure right. */
const fixes = {
  reachable: "Start the server, or check the address and the key.",
  tools: "Use a model with tool support (function calling), served with it on.",
  context: (contextSize: number) =>
    `Set Ollama's context to at least ${contextSize} tokens, with the environment variable OLLAMA_CONTEXT_LENGTH=${contextSize} ` +
    `or \`PARAMETER num_ctx ${contextSize}\` in a Modelfile (or your server's own context setting), and restart it; or give a smaller context size.`,
};

class Unreachable extends Error {}

/** Tries the model's server with both requests; the failures, none when it can do a Run. */
export async function checkModelWorks(model: MachineModel, key: string | undefined, options: CheckOptions = {}): Promise<CheckFailure[]> {
  const hide = (text: string) => (key ? text.split(key).join("***") : text);
  const post = async (body: unknown, timeoutMs: number) => {
    let response: Response;
    try {
      response = await fetch(`${model.address}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: model.modelId, stream: false, ...(body as object) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const cause = (error as Error).name === "TimeoutError" ? `no answer within ${Math.round(timeoutMs / 1000)} seconds` : messageOf(error);
      throw new Unreachable(hide(cause));
    }
    const text = await response.text().catch(() => "");
    return { status: response.status, ok: response.ok, text, json: parse(text) };
  };

  // 1. A tool call. A server that can't be reached fails here, and the long request would only say so again.
  let tools;
  try {
    tools = await post(
      {
        max_tokens: 256,
        messages: [{ role: "user", content: "Call the tool get_time with the timezone UTC. Don't answer in text." }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_time",
              description: "The current time in a timezone.",
              parameters: { type: "object", properties: { timezone: { type: "string" } }, required: ["timezone"] },
            },
          },
        ],
      },
      options.toolsTimeoutMs ?? 60_000,
    );
  } catch (error) {
    return [{ check: "reachable", what: `The server can't be reached: ${(error as Error).message}.`, fix: fixes.reachable }];
  }
  if (!tools.ok) {
    return [{ check: "reachable", what: `The server answered ${tools.status}${serverMessage(tools, hide)}.`, fix: fixes.reachable }];
  }
  const failures: CheckFailure[] = [];
  const toolCalls = (tools.json as { choices?: { message?: { tool_calls?: unknown[] } }[] })?.choices?.[0]?.message?.tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    failures.push({ check: "tools", what: "The model answered without calling the tool it was asked to call.", fix: fixes.tools });
  }

  // 2. The marker at the start of a prompt close to the context size, asked back.
  const marker = `MARKER-${randomBytes(4).toString("hex")}`;
  const words = Math.max(1, Math.floor(model.contextSize * contextShare) - 100);
  const filler = Array.from({ length: words }, (_, i) => fillerWords[i % fillerWords.length]).join(" ");
  const prompt =
    `Remember this marker: ${marker}\n\n${filler}\n\n` +
    "That was filler. Answer with the marker given at the very start of this message, and nothing else.";
  options.note?.("Checking the context size with a long prompt (this can take a few minutes)…");
  let context;
  try {
    context = await post({ max_tokens: 64, messages: [{ role: "user", content: prompt }] }, options.contextTimeoutMs ?? 5 * 60_000);
  } catch (error) {
    failures.push({ check: "context", what: `The long prompt got no answer: ${(error as Error).message}.`, fix: fixes.context(model.contextSize) });
    return failures;
  }
  if (!context.ok) {
    failures.push({
      check: "context",
      what: `The server refused a prompt of about ${words} tokens (answered ${context.status}${serverMessage(context, hide)}).`,
      fix: fixes.context(model.contextSize),
    });
    return failures;
  }
  const answer = context.json as { choices?: { message?: { content?: unknown } }[]; usage?: { prompt_tokens?: unknown } };
  const content = answer?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.includes(marker)) {
    const seen = answer?.usage?.prompt_tokens;
    failures.push({
      check: "context",
      what:
        `The model lost the marker at the start of a prompt of about ${words} tokens` +
        (typeof seen === "number" ? `: the server saw ${seen} of them` : "") +
        `, so it is served with a smaller context than ${model.contextSize}.`,
      fix: fixes.context(model.contextSize),
    });
  }
  return failures;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  const { message, cause } = error as Error & { cause?: { message?: string; code?: string } };
  return cause?.code ?? cause?.message ?? message;
}

/** The server's error message, if it gave one, shortened and with the key hidden. */
function serverMessage(answer: { text: string; json: unknown }, hide: (text: string) => string): string {
  const error = (answer.json as { error?: { message?: unknown } | string })?.error;
  const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : answer.text;
  const trimmed = message.trim().replace(/\s+/g, " ").slice(0, 300);
  return trimmed ? `: ${hide(trimmed)}` : "";
}
