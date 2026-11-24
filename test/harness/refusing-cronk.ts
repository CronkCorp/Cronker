import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export const tooOldMessage = "This Cronk works with cronk-runner 9.0.0 or later, and this Machine runs 0.3.0: upgrade cronk-runner to 9.0.0 or later, then start it again.";

/** A stand-in Cronk that refuses every Machine call as `daemon_too_old`, as a Cronk newer than the daemon does. */
export async function refusingCronk() {
  let calls = 0;
  let headers: Record<string, unknown> = {};
  const server = createServer((request, response) => {
    calls++;
    headers = request.headers;
    response.writeHead(426, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "daemon_too_old", message: tooOldMessage } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls: () => calls,
    /** The headers of the last call. */
    headers: () => headers,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
