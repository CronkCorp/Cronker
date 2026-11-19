import { systemClock } from "./clock.js";
import { ConfigError, loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";
import { InstallationTokens } from "./github/installations.js";
import { Live } from "./live/live.js";
import { ApiError } from "./http/errors.js";
import { issueResetLinkByEmail } from "./identity/links.js";

/**
 * Server commands, for whoever runs Cronk, configured by the same environment variables
 * as the server. With Docker Compose: `docker compose exec cronk node dist/server/command.js …`.
 */

const usage = `Usage: command reset-link <email>

  reset-link <email>   Print a one-time link, valid 7 days, that sets a new password
                       for the User with this email and ends their sign-ins.`;

async function main(args: string[]): Promise<number> {
  const [name, email, ...rest] = args;
  if (name !== "reset-link" || !email || rest.length > 0) {
    console.error(usage);
    return 2;
  }

  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`Cronk can't run the command: ${error.message}`);
    return 1;
  }

  const db = createPool(config.databaseUrl);
  try {
    await migrate(db);
    const { user, link } = await issueResetLinkByEmail({ config, db, clock: systemClock, live: new Live(), runners: {}, installationTokens: new InstallationTokens(systemClock) }, email);
    console.log(`Pass this link to ${user.email}. It sets a new password, works once and expires ${link.expiresAt}:`);
    console.log(link.url);
    return 0;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    console.error(error.message);
    return 1;
  } finally {
    await db.end();
  }
}

process.exitCode = await main(process.argv.slice(2));
