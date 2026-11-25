import type { AttachmentStorage } from "./attachments/storage.js";
import type { Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { GitHubStatus } from "./github/status.js";
import type { InstallationListings, InstallationTokens } from "./github/installations.js";
import type { Jobs } from "./jobs.js";
import type { LookupFunction } from "node:net";
import type { Live } from "./live/live.js";
import type { Runner } from "./runs/runner.js";

/** What every part of the app is built from. */
export interface Context {
  config: Config;
  db: Db;
  clock: Clock;
  /** The open event streams, told about changes once they commit. */
  live: Live;
  /** The Runners this installation can start Runs through, by kind. */
  runners: Record<string, Runner>;
  /** The GitHub App's installation tokens, held until shortly before they expire. */
  installationTokens: InstallationTokens;
  /** What GitHub last said the App's installations cover, kept for a few minutes. */
  installationListings: InstallationListings;
  /** Whether GitHub's API is available, or Cronk is waiting out an outage or its rate limit. */
  githubStatus: GitHubStatus;
  /** Where Attachments' bytes are kept. */
  attachments: AttachmentStorage;
  /** Work done after a change commits, without the response waiting for it. */
  jobs: Jobs;
  /** How host names Users give, such as webhooks', are resolved: the system's resolver unless a test stands one in. */
  resolver?: LookupFunction;
}
