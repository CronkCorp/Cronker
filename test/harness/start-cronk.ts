import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createCronk, type Cronk } from "../../server/cronk.js";
import { TestClock } from "./clock.js";
import { createTestDatabase } from "./database.js";
import { startStandInClaude, type StandInClaude } from "./claude.js";
import { startStandInGitHub, type StandInGitHub } from "./github.js";
import { FakeRunner } from "./runner.js";

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
  /** The stand-in GitHub this Cronk talks to instead of the real one. */
  github: StandInGitHub;
  /** The stand-in claude.ai fire endpoint the subscription Runner fires scheduled tasks at. */
  claude: StandInClaude;
  /** The fake Runner, installed as the Runner kind `fake`: what it was asked to start, and what to do next. */
  runner: FakeRunner;
  clock: TestClock;
  /** Runs the periodic check that makes Runs lost, as the server does every minute; move the clock first. */
  checkForLostRuns(): Promise<void>;
  /** Resumes the queues of Runners whose rate limit has passed, as the server does every minute; move the clock first. */
  resumePausedRunners(): Promise<void>;
  logs: LogLine[];
  /** The setup code from the server log. */
  setupCode(): string;
  request(method: string, path: string, options?: RequestOptions): Promise<Response>;
  /** Terminates Cronk's idle database connections from an admin connection, as a Postgres restart would; returns how many. */
  terminateIdleDatabaseConnections(): Promise<number>;
  /** The files in the directory Cronk keeps Attachments in. */
  attachmentFiles(): Promise<string[]>;
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
  /** Start without `CRONK_SECRET_KEY`, so nothing can be stored encrypted. */
  noSecretKey?: boolean;
  /** The size limit of each Attachment, in bytes; 25 MB, the default, when left out. */
  attachmentLimitBytes?: number;
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
  const github = await startStandInGitHub(clock);
  const claude = await startStandInClaude();
  const runner = new FakeRunner();
  const logs: LogLine[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim()) logs.push(JSON.parse(line) as LogLine);
      }
      callback();
    },
  });

  const attachmentsDirectory = await mkdtemp(join(tmpdir(), "cronk-attachments-"));
  const removeAttachments = () => rm(attachmentsDirectory, { recursive: true, force: true });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let cronk: Cronk;
  try {
    cronk = await createCronk({
      config: {
        publicUrl: new URL(url),
        databaseUrl: database.url,
        host: "127.0.0.1",
        port,
        webRoot: options.webRoot,
        secretKey: options.noSecretKey ? undefined : randomBytes(32).toString("base64"),
        github: { url: new URL(github.url), apiUrl: new URL(github.apiUrl) },
        claudeApiUrl: new URL(claude.apiUrl),
        attachments: { directory: attachmentsDirectory, limitBytes: options.attachmentLimitBytes ?? 25 * 1024 * 1024 },
      },
      clock,
      logStream,
      runnerKinds: { fake: runner.kind },
    });
    await cronk.listen();
  } catch (error) {
    await Promise.all([database.drop(), github.stop(), claude.stop(), removeAttachments()]);
    throw error;
  }

  return {
    url,
    github,
    claude,
    runner,
    clock,
    checkForLostRuns: () => cronk.checkForLostRuns(),
    resumePausedRunners: () => cronk.resumePausedRunners(),
    logs,
    setupCode() {
      const line = logs.find((l) => typeof l.setupCode === "string");
      if (!line) throw new Error("no setup code in the server log");
      return line.setupCode as string;
    },
    terminateIdleDatabaseConnections: () => database.terminateIdleConnections(),
    attachmentFiles: async () => (await readdir(attachmentsDirectory).catch(() => [])).sort(),
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
      await Promise.all([database.drop(), github.stop(), claude.stop(), removeAttachments()]);
    },
  };
}
