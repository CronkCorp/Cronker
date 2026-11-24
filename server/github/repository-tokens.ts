import type { Context } from "../context.js";
import { appToken } from "./app.js";
import { installationToken } from "./client.js";
import { installationCovering } from "./installations.js";

/**
 * Fresh installation tokens of the GitHub App's for the Repositories a Run works in, as Managed Agents sessions mount
 * them and local Runs push with them (ADR 0007).
 */

/** How long before a Run's token expires Cronk gives it a fresh one. */
export const tokenRotationMarginMs = 10 * 60 * 1000;

/** The address a Run clones the Repository from, under GitHub's web address. */
export function repositoryUrl(context: Context, fullName: string): string {
  const base = context.config.github.url.href;
  return new URL(fullName, base.endsWith("/") ? base : `${base}/`).toString();
}

/**
 * Gives fresh installation tokens for Repositories, one per installation covering them however many it is asked for.
 * Fresh, rather than the tokens Cronk holds for its own calls, so each lasts the hour GitHub gives it; Cronk gives the
 * Run a new one before it expires. Throws when GitHub can't be asked or the App covers a Repository no longer.
 */
export function freshTokens(context: Context): (repository: { id: number; fullName: string }) => Promise<{ token: string; expiresAt: Date }> {
  const tokens = new Map<number, Promise<{ token: string; expiresAt: Date }>>();
  return async (repository) => {
    const installationId = await installationCovering(context, repository.id);
    if (installationId === undefined) throw new Error(`The GitHub App isn't installed on ${repository.fullName} any more.`);
    if (!tokens.has(installationId)) {
      const fetching = appToken(context).then((jwt) => installationToken(context.config, jwt, installationId));
      // A failed fetch is reported to each Repository that awaits it; none is left unhandled.
      fetching.catch(() => {});
      tokens.set(installationId, fetching);
    }
    return tokens.get(installationId)!;
  };
}

/** A Repository with a fresh installation token of the GitHub App's for it. */
export interface RepositoryWithToken {
  id: number;
  fullName: string;
  token: string;
  expiresAt: Date;
}

/** The Repositories, each with a fresh installation token. */
export async function withFreshTokens(context: Context, repositories: { id: number; fullName: string }[]): Promise<RepositoryWithToken[]> {
  const tokenFor = freshTokens(context);
  const withTokens: RepositoryWithToken[] = [];
  for (const repository of repositories) withTokens.push({ ...repository, ...(await tokenFor(repository)) });
  return withTokens;
}
