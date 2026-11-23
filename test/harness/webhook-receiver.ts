import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in webhook receiver: an HTTP server on 127.0.0.1 that records every delivery with its headers and body, and
 * answers 204, or as it was told to with `failNext()` and `redirectNext()`.
 */

export interface ReceivedDelivery {
  path: string;
  headers: IncomingHttpHeaders;
  /** The body exactly as it arrived, which the signature covers. */
  body: string;
  /** What the receiver answered: a status code, or `drop` when it cut the connection. */
  answer: number | "drop";
}

export interface StandInWebhookReceiver {
  /** Where to point a webhook; any path under it is received the same way. */
  url: string;
  /** Every delivery received, oldest first. */
  received: ReceivedDelivery[];
  /** Answers the next `count` deliveries with this status, or by cutting the connection without an answer. */
  failNext(count: number, answer: number | "drop"): void;
  /** Answers the next delivery with a 302 redirect to this URL. */
  redirectNext(location: string): void;
  stop(): Promise<void>;
}

export async function startStandInWebhookReceiver(): Promise<StandInWebhookReceiver> {
  const received: ReceivedDelivery[] = [];
  const failures: (number | "drop")[] = [];
  const redirects: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const location = redirects.shift();
      const answer = location ? 302 : (failures.shift() ?? 204);
      received.push({ path: request.url ?? "/", headers: request.headers, body: Buffer.concat(chunks).toString("utf8"), answer });
      if (answer === "drop") {
        request.socket.destroy();
        return;
      }
      response.writeHead(answer, location ? { location } : {}).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    failNext(count, answer) {
      for (let i = 0; i < count; i++) failures.push(answer);
    },
    redirectNext(location) {
      redirects.push(location);
    },
    stop: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
