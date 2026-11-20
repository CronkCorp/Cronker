import type { AttachmentStorage } from "./attachments/storage.js";
import type { Clock } from "./clock.js";
import type { Config } from "./config.js";
import type { Db } from "./db.js";
import type { InstallationListings, InstallationTokens } from "./github/installations.js";
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
  /** Where Attachments' bytes are kept. */
  attachments: AttachmentStorage;
}
