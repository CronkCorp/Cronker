import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import type { Context } from "../context.js";
import { appToken } from "./app.js";
import { appInstallations, installationRepositories, installationToken } from "./client.js";

/**
 * The App's installations on GitHub accounts and organizations, and the tokens Cronk acts
 * on an installation's Repositories with. GitHub's installation tokens last an hour; Cronk
 * fetches one when it first needs it and reuses it until five minutes before it expires.
 */

/** How long before a token expires Cronk stops using it, so none expires mid-call. */
const expiryMarginMs = 5 * 60 * 1000;

/** Installation tokens Cronk holds, in memory only, by installation id. */
export class InstallationTokens {
  readonly #tokens = new Map<number, Promise<{ token: string; expiresAt: Date }>>();

  constructor(private readonly clock: Clock) {}

  /** A token for the installation, fetched with `fetchToken` unless the one held is still good. */
  async get(installationId: number, fetchToken: () => Promise<{ token: string; expiresAt: Date }>): Promise<string> {
    const held = await this.#tokens.get(installationId)?.catch(() => undefined);
    if (held && held.expiresAt.getTime() - expiryMarginMs > this.clock.now().getTime()) return held.token;
    // A failed fetch isn't kept, so the next call tries again.
    const fetching = fetchToken();
    this.#tokens.set(installationId, fetching);
    fetching.catch(() => {
      if (this.#tokens.get(installationId) === fetching) this.#tokens.delete(installationId);
    });
    return (await fetching).token;
  }
}

export const Installation = Type.Object({
  /** The GitHub account or organization the App is installed on. */
  account: Type.String(),
  repositories: Type.Array(
    Type.Object({ id: Type.Integer({ description: "GitHub's id for the Repository." }), fullName: Type.String({ description: "`owner/name`." }) }),
  ),
});
export type Installation = Static<typeof Installation>;

/** A token for acting on one installation's Repositories, as the App. */
export async function tokenFor(context: Context, installationId: number): Promise<string> {
  return context.installationTokens.get(installationId, async () =>
    installationToken(context.config, await appToken(context), installationId),
  );
}

/** Orders Repositories by `owner/name`, ignoring case, so every client lists them alike. */
function byFullName(a: { fullName: string }, b: { fullName: string }): number {
  const [x, y] = [a.fullName.toLowerCase(), b.fullName.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  return a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0;
}

/** Every installation of the App, with the Repositories it covers, sorted by `owner/name` ignoring case. */
export async function listInstallations(context: Context): Promise<Installation[]> {
  const { config } = context;
  const installations = await appInstallations(config, await appToken(context));
  return Promise.all(
    installations.map(async (installation) => ({
      account: installation.account.login,
      repositories: (await installationRepositories(config, await tokenFor(context, installation.id)))
        .map((r) => ({ id: r.id, fullName: r.full_name }))
        .sort(byFullName),
    })),
  );
}
