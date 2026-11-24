import { execFile } from "node:child_process";
import { access, chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { ClaimedRepository, RepositoryToken } from "./api.js";

/**
 * A Run's Repositories on the Machine. The daemon keeps one bare clone per Repository in its cache directory, fetched
 * with the Run's GitHub App token, and gives each Run a fresh worktree of each: on the Ticket's branch if the remote
 * has it, or else off the Repository's default branch, detached, for the Run to name its own branch.
 *
 * The tokens never go in argv, a remote URL or the agent's directory: they sit in files only the User reads, in the
 * Run's own directory, and a git credential helper reads them, so `git fetch` and `git push` use the App's token and
 * a fresh token a heartbeat brings is used from then on without restarting anything. A `gh` on the PATH is wrapped to
 * read the token the same way.
 */

const run = promisify(execFile);

/** The Run's worktrees, the environment its `claude` runs with, and how to refresh its tokens and let go of them. */
export interface RunWorkspace {
  /** The directory `claude` runs in: the worktree of a single Repository, or the parent of several. */
  cwd: string;
  /** Additions to the environment `claude` runs with: the credential helper's git config, and a PATH with `gh` wrapped. */
  env: NodeJS.ProcessEnv;
  /** Writes fresh tokens, as a heartbeat answers them. */
  refresh(tokens: RepositoryToken[]): Promise<void>;
  /** Removes the worktrees, and the branches made for them, from the bare clones. */
  remove(): Promise<void>;
}

export interface RepositoryCacheOptions {
  /** Where the bare clones live. */
  directory: string;
  /** The remote a Repository is fetched from and pushed to; its `cloneUrl` when left out. Tests point it elsewhere. */
  remoteFor?: (repository: ClaimedRepository) => string;
}

/** The file of the Repository's token, in the Run's token directory: `owner__name`. */
const tokenFile = (fullName: string) => fullName.replace(/\//g, "__");

/**
 * Answers `git credential fill` for the GitHub App: the token of the Repository whose path git asks about (the last two
 * segments, without `.git`), or the first Repository's when the path names none of them.
 */
const credentialHelper = (tokens: string) => `#!/bin/sh
[ "$1" = get ] || exit 0
path=""
while IFS= read -r line; do
  case "$line" in path=*) path="\${line#path=}" ;; esac
done
path="\${path%.git}"
name="\${path##*/}"
rest="\${path%/*}"
owner="\${rest##*/}"
file="${tokens}/\${owner}__\${name}"
[ -n "$name" ] && [ -f "$file" ] || file="${tokens}/default"
printf 'username=x-access-token\\npassword=%s\\n' "$(cat "$file")"
`;

/** Runs `gh` with the first Repository's token, read when it is run, so it is always the freshest. */
const ghWrapper = (tokens: string, gh: string) => `#!/bin/sh
GH_TOKEN="$(cat "${tokens}/default")" exec "${gh}" "$@"
`;

/** The executable of that name on the PATH, if any. */
async function onPath(
  name: string,
  path: string | undefined,
): Promise<string | undefined> {
  for (const directory of (path ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** Writes a file only its User reads, replacing the old one in one step. */
async function writePrivate(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, content, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export function repositoryCache(options: RepositoryCacheOptions) {
  const remoteFor =
    options.remoteFor ??
    ((repository: ClaimedRepository) => repository.cloneUrl);
  /** One git operation at a time on each bare clone, so two Runs never race on one. */
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(clone: string, work: () => Promise<T>): Promise<T> => {
    const next = (locks.get(clone) ?? Promise.resolve()).then(work, work);
    locks.set(
      clone,
      next.catch(() => {}),
    );
    return next;
  };

  /**
   * Makes the Run's worktrees under `runDirectory`: tokens in `tokens/`, the credential helper in `bin/`, and the
   * worktrees in `work/`, one per Repository by name when there are several. Undoes what it made if one fails.
   */
  async function prepare(
    runDirectory: string,
    repositories: ClaimedRepository[],
    baseEnv: NodeJS.ProcessEnv,
  ): Promise<RunWorkspace> {
    const work = join(runDirectory, "work");
    await mkdir(work, { recursive: true });
    if (repositories.length === 0)
      return {
        cwd: work,
        env: {},
        refresh: async () => {},
        remove: async () => {},
      };

    const tokens = join(runDirectory, "tokens");
    const bin = join(runDirectory, "bin");
    await mkdir(tokens, { mode: 0o700 });
    await mkdir(bin, { mode: 0o700 });
    const refresh = async (fresh: RepositoryToken[]) => {
      for (const { fullName, token } of fresh) {
        const known = repositories.findIndex((r) => r.fullName === fullName);
        if (known < 0) continue;
        await writePrivate(join(tokens, tokenFile(fullName)), token);
        if (known === 0) await writePrivate(join(tokens, "default"), token);
      }
    };
    await refresh(repositories);
    const helper = join(bin, "git-credential-cronk");
    await writePrivate(helper, credentialHelper(tokens), 0o700);
    const realGh = await onPath("gh", baseEnv.PATH);
    if (realGh)
      await writePrivate(join(bin, "gh"), ghWrapper(tokens, realGh), 0o700);

    // Every GitHub address the Repositories are at uses only the helper: none of the User's own credentials.
    const config: [string, string][] = [];
    for (const origin of new Set(
      repositories.map((r) => new URL(r.cloneUrl).origin),
    )) {
      config.push(
        [`credential.${origin}.helper`, ""],
        [`credential.${origin}.helper`, helper],
        [`credential.${origin}.useHttpPath`, "true"],
      );
    }
    const env: NodeJS.ProcessEnv = {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: String(config.length),
      ...Object.fromEntries(
        config.flatMap(([key, value], i) => [
          [`GIT_CONFIG_KEY_${i}`, key],
          [`GIT_CONFIG_VALUE_${i}`, value],
        ]),
      ),
      PATH: realGh ? `${bin}${delimiter}${baseEnv.PATH ?? ""}` : baseEnv.PATH,
    };
    const gitEnv = { ...baseEnv, ...env };
    const git = (args: string[], cwd?: string) =>
      run("git", args, { cwd, env: gitEnv, maxBuffer: 16 * 1024 * 1024 });

    const made: { clone: string; path: string; branch: string | null }[] = [];
    const remove = async () => {
      for (const { clone, path, branch } of made.splice(0).reverse()) {
        await locked(clone, async () => {
          await git(["-C", clone, "worktree", "remove", "--force", path]).catch(
            () => {},
          );
          if (branch)
            await git(["-C", clone, "branch", "-D", branch]).catch(() => {});
          await git(["-C", clone, "worktree", "prune"]).catch(() => {});
        });
      }
    };
    try {
      for (const repository of repositories) {
        const clone = join(
          options.directory,
          `${tokenFile(repository.fullName)}.git`,
        );
        const path =
          repositories.length === 1
            ? work
            : join(work, repository.fullName.split("/").pop()!);
        await locked(clone, async () => {
          const remote = remoteFor(repository);
          if (await isBareClone(clone)) {
            await git(["-C", clone, "remote", "set-url", "origin", remote]);
          } else {
            await mkdir(options.directory, { recursive: true, mode: 0o700 });
            await git(["init", "--bare", "--quiet", clone]);
            await git(["-C", clone, "remote", "add", "origin", remote]);
          }
          await git(["-C", clone, "fetch", "--prune", "--quiet", "origin"]);
          await git(["-C", clone, "remote", "set-head", "origin", "--auto"]);
          // Worktrees of Runs gone without cleaning up, as when the daemon was killed.
          await git(["-C", clone, "worktree", "prune"]);
          const branch = repository.startBranch;
          const onRemote =
            branch !== null &&
            (await git([
              "-C",
              clone,
              "rev-parse",
              "--verify",
              "--quiet",
              `refs/remotes/origin/${branch}^{commit}`,
            ]).then(
              () => true,
              () => false,
            ));
          if (onRemote) {
            await git([
              "-C",
              clone,
              "worktree",
              "add",
              "--quiet",
              "--force",
              "-B",
              branch,
              path,
              `origin/${branch}`,
            ]);
            made.push({ clone, path, branch });
          } else {
            const { stdout } = await git([
              "-C",
              clone,
              "symbolic-ref",
              "refs/remotes/origin/HEAD",
            ]);
            await git([
              "-C",
              clone,
              "worktree",
              "add",
              "--quiet",
              "--detach",
              path,
              stdout.trim(),
            ]);
            made.push({ clone, path, branch: null });
          }
        });
      }
    } catch (error) {
      await remove();
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(
        stderr ? stderr.split("\n").at(-1) : (error as Error).message,
      );
    }
    return { cwd: work, env, refresh, remove };
  }

  return { prepare };
}

async function isBareClone(path: string): Promise<boolean> {
  try {
    await access(join(path, "HEAD"));
    return true;
  } catch {
    return false;
  }
}
