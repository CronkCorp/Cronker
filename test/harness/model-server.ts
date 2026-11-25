import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in OpenAI-compatible model server, as Ollama or a hosted API would be: it answers `GET /v1/models` and
 * `POST /v1/chat/completions` while up, and refuses a request without the key when it has one. It records each
 * request's path, authorization and body.
 *
 * A chat request offering tools gets a tool call, unless told to refuse them; any other answers with the marker
 * (`MARKER-<hex>`) it kept. It counts each word of a prompt as a token and, like Ollama, silently drops the start of a
 * prompt longer than its loaded context, or refuses the length outright when told to.
 */
export interface StandInModelServer {
  /** Its address as a Machine model is set up with, such as `http://127.0.0.1:1234/v1`. */
  address: string;
  requests: { path: string; authorization: string | undefined; body: unknown }[];
  /** While down, every request is answered 503. */
  setUp(up: boolean): void;
  stop(): Promise<void>;
}

export interface StandInModelOptions {
  key?: string;
  /** Whether a request offering tools gets a tool call, or a plain answer; `call` when left out. */
  tools?: "call" | "refuse";
  /** The context it loaded, in tokens (words); a longer prompt loses its start. No limit when left out. */
  loadedContext?: number;
  /** Refuse a prompt longer than its loaded context with a 400, echoing the request's authorization, as some do. */
  refuseLength?: boolean;
}

export async function standInModelServer(options: StandInModelOptions = {}): Promise<StandInModelServer> {
  const { key } = options;
  let up = true;
  const requests: StandInModelServer["requests"] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization, body });
    const json = (status: number, answer: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer));
    };
    if (!up) return json(503, { error: { message: "loading" } });
    if (key && request.headers.authorization !== `Bearer ${key}`) return json(401, { error: { message: "bad key" } });
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(200, { object: "list", data: [{ id: "qwen3.5:9b", object: "model" }] });
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      const chat = body as { model?: string; messages?: { content?: string }[]; tools?: { function: { name: string } }[] };
      const reply = (message: Record<string, unknown>, promptTokens: number) =>
        json(200, {
          object: "chat.completion",
          model: chat.model,
          choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: promptTokens, completion_tokens: 5 },
        });
      if (chat.tools?.length) {
        if (options.tools === "refuse") return reply({ content: "It is noon in UTC." }, 20);
        const tool = chat.tools[0]!.function.name;
        return reply({ content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: tool, arguments: '{"timezone":"UTC"}' } }] }, 20);
      }
      let words = (chat.messages ?? []).flatMap((m) => String(m.content ?? "").split(/\s+/).filter(Boolean));
      const loaded = options.loadedContext ?? Infinity;
      if (words.length > loaded) {
        if (options.refuseLength) {
          return json(400, {
            error: { message: `prompt is ${words.length} tokens, over the maximum context length ${loaded} (${request.headers.authorization})` },
          });
        }
        words = words.slice(words.length - loaded);
      }
      const marker = words.join(" ").match(/MARKER-[0-9a-f]+/)?.[0];
      return reply({ content: marker ? `The marker is ${marker}.` : "I don't see a marker." }, words.length);
    }
    json(404, { error: { message: "not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    address: `http://127.0.0.1:${port}/v1`,
    requests,
    setUp: (value) => {
      up = value;
    },
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
