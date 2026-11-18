import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createCronk, type Cronk } from "../../server/cronk.js";
import { TestClock } from "./clock.js";
import { createTestDatabase } from "./database.js";

/**
 * Starts Cronk in-process against its own disposable database, with the clock
 * under the test's control and the server log captured.
 */

export interface LogLine {
  level: number;
  msg: string;
  [key: string]: unknown;
}

export interface RequestOptions {
  body?: unknown;
  cookie?: string;
  origin?: string;
  headers?: Record<string, string>;
}

export interface StartedCronk {
  /** Cronk's public address, which is also where it listens. */
  url: string;
  clock: TestClock;
  logs: LogLine[];
  /** The setup code from the server log. */
  setupCode(): string;
  request(method: string, path: string, options?: RequestOptions): Promise<Response>;
  /** Runs a server command (`server/command.ts`) against this Cronk's database, as an operator would. */
  command(...args: string[]): Promise<CommandResult>;
  stop(): Promise<void>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface StartCronkOptions {
  clock?: TestClock;
  /** Directory of the built web client to serve, if any. */
  webRoot?: string;
}

const commandScript = fileURLToPath(new URL("../../server/command.ts", import.meta.url));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("no port"));
      });
    });
  });
}

export async function startCronk(options: StartCronkOptions = {}): Promise<StartedCronk> {
  const database = await createTestDatabase();
  const clock = options.clock ?? new TestClock();
  const logs: LogLine[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) logs.push(JSON.parse(line) as LogLine);
      }
      callback();
    },
  });

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let cronk: Cronk;
  try {
    cronk = await createCronk({
      config: { publicUrl: new URL(url), databaseUrl: database.url, host: "127.0.0.1", port, webRoot: options.webRoot },
      clock,
      logStream,
    });
    await cronk.listen();
  } catch (error) {
    await database.drop();
    throw error;
  }

  return {
    url,
    clock,
    logs,
    setupCode() {
      const line = logs.find((l) => typeof l.setupCode === "string");
      if (!line) throw new Error("no setup code in the server log");
      return line.setupCode as string;
    },
    request(method, path, { body, cookie, origin, headers = {} } = {}) {
      const all: Record<string, string> = { ...headers };
      if (body !== undefined) all["content-type"] = "application/json";
      if (cookie) all.cookie = cookie;
      if (origin) all.origin = origin;
      return fetch(new URL(path, url), {
        method,
        headers: all,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    command(...args) {
      return new Promise((resolve) => {
        execFile(
          process.execPath,
          ["--import", "tsx", commandScript, ...args],
          { env: { ...process.env, DATABASE_URL: database.url, CRONK_PUBLIC_URL: url } },
          (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
        );
      });
    },
    async stop() {
      await cronk.close();
      await database.drop();
    },
  };
}
