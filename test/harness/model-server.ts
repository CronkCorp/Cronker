import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in OpenAI-compatible model server, as Ollama or a hosted API would be: it answers `GET /v1/models` while up,
 * and refuses a request without the key when it has one. It records each request's path and authorization.
 */
export interface StandInModelServer {
  /** Its address as a Machine model is set up with, such as `http://127.0.0.1:1234/v1`. */
  address: string;
  requests: { path: string; authorization: string | undefined }[];
  /** While down, every request is answered 503. */
  setUp(up: boolean): void;
  stop(): Promise<void>;
}

export async function standInModelServer({ key }: { key?: string } = {}): Promise<StandInModelServer> {
  let up = true;
  const requests: StandInModelServer["requests"] = [];
  const server = createServer((request: IncomingMessage, response) => {
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (!up) return json(503, { error: { message: "loading" } });
    if (key && request.headers.authorization !== `Bearer ${key}`) return json(401, { error: { message: "bad key" } });
    if (request.method === "GET" && request.url === "/v1/models") {
      return json(200, { object: "list", data: [{ id: "qwen3.5:9b", object: "model" }] });
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
