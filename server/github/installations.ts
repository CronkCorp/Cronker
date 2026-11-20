import { Type, type Static } from "typebox";
import type { Clock } from "../clock.js";
import type { Context } from "../context.js";
import { appToken } from "./app.js";
import { appInstallations, installationRepositories, installationToken } from "./client.js";

/**
 * The App's installations on GitHub accounts and organizations, and the tokens Cronk acts
 * on an installation's Repositories with. GitHub's installation tokens last an hour; Cronk
 * fetches one when it first needs it and reuses it until five minutes before it expires.
 * What GitHub says the installations cover is kept for five minutes, per installation, so
 * the Add Repository picker answers quickly after the first time.
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

/** How long Cronk keeps what GitHub said the App's installations are and which Repositories each covers. */
const listingLifetimeMs = 5 * 60 * 1000;

interface ListedInstallation {
  id: number;
  account: string;
}

interface ListedRepository {
  id: number;
  fullName: string;
}

/** Values fetched from GitHub, kept in memory by key until their lifetime passes or they are forgotten. */
class Kept<K, V> {
  readonly #held = new Map<K, { until: number; value: Promise<V> }>();

  constructor(private readonly clock: Clock) {}

  /** The value kept for `key`, unless it has expired or `refresh` asks GitHub again; then `fetch`'s, which is kept. */
  async get(key: K, fetch: () => Promise<V>, refresh: boolean): Promise<V> {
    const now = this.clock.now().getTime();
    const held = this.#held.get(key);
    if (!refresh && held && held.until > now) return held.value;
    const fetching = fetch();
    const entry = { until: now + listingLifetimeMs, value: fetching };
    this.#held.set(key, entry);
    // A failed fetch isn't kept, so the next call tries again.
    fetching.catch(() => {
      if (this.#held.get(key) === entry) this.#held.delete(key);
    });
    return fetching;
  }

  /** Forgets the value kept for `key`, so the next call asks GitHub. */
  forget(key: K): void {
    this.#held.delete(key);
  }

  /** Forgets every value kept. */
  clear(): void {
    this.#held.clear();
  }

  /** Forgets every value but those kept for `keys`. */
  keepOnly(keys: K[]): void {
    for (const key of this.#held.keys()) if (!keys.includes(key)) this.#held.delete(key);
  }
}

/**
 * What GitHub last said the App's installations are, and the Repositories each covers, in
 * memory only. Each is asked again five minutes after it was last asked, or at once once forgotten.
 */
export class InstallationListings {
  /** The installations, under the one key `all`. */
  readonly installations: Kept<"all", ListedInstallation[]>;
  /** Each installation's Repositories, by installation id. */
  readonly repositories: Kept<number, ListedRepository[]>;

  constructor(clock: Clock) {
    this.installations = new Kept(clock);
    this.repositories = new Kept(clock);
  }

  /** Forgets the Repositories kept for one installation, as after a rename there. */
  forgetRepositoriesOf(installationId: number): void {
    this.repositories.forget(installationId);
  }

  /** Forgets everything kept, as when Cronk learns the Repositories the App covers may have changed. */
  forget(): void {
    this.installations.clear();
    this.repositories.clear();
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

/** Orders names alphabetically ignoring case, the same on every server whatever its locale. */
function ignoringCase(a: string, b: string): number {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The App's installations, as GitHub said within the last five minutes unless `refresh` asks afresh. */
async function installationsListed(context: Context, refresh: boolean): Promise<ListedInstallation[]> {
  const { config, installationListings: kept } = context;
  const installations = await kept.installations.get(
    "all",
    async () => (await appInstallations(config, await appToken(context))).map((i) => ({ id: i.id, account: i.account.login })),
    refresh,
  );
  // An installation removed from GitHub isn't listed again, so nothing it covered is kept.
  kept.repositories.keepOnly(installations.map((i) => i.id));
  return installations;
}

/** The Repositories one installation covers, as GitHub said within the last five minutes unless `refresh` asks afresh. */
async function repositoriesCovered(context: Context, installationId: number, refresh: boolean): Promise<ListedRepository[]> {
  return context.installationListings.repositories.get(
    installationId,
    async () =>
      (await installationRepositories(context.config, await tokenFor(context, installationId)))
        .map((r) => ({ id: r.id, fullName: r.full_name }))
        .sort((a, b) => ignoringCase(a.fullName, b.fullName)),
    refresh,
  );
}

/**
 * The installation of the App covering the Repository, by GitHub's id, if one does. What GitHub said within the last
 * five minutes is used first; GitHub is asked afresh when that names none.
 */
export async function installationCovering(context: Context, repositoryId: number): Promise<number | undefined> {
  for (const refresh of [false, true]) {
    for (const installation of await installationsListed(context, refresh)) {
      if ((await repositoriesCovered(context, installation.id, refresh)).some((r) => r.id === repositoryId)) return installation.id;
    }
  }
  return undefined;
}

/**
 * Every installation of the App, by account, with the Repositories it covers by `owner/name`, both
 * ignoring case, so every client lists them alike. What GitHub said within the last five minutes
 * is used again, unless `refresh` asks GitHub afresh.
 */
export async function listInstallations(context: Context, { refresh = false } = {}): Promise<Installation[]> {
  const installations = await installationsListed(context, refresh);
  const listed = await Promise.all(
    installations.map(async (installation) => ({
      account: installation.account,
      repositories: await repositoriesCovered(context, installation.id, refresh),
    })),
  );
  return listed.sort((a, b) => ignoringCase(a.account, b.account));
}

