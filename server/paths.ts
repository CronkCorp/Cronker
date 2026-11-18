import { fileURLToPath } from "node:url";

// The server runs from source (server/) in development and from dist/server once built.
const runningFromDist = import.meta.url.includes("/dist/server/");
const repoRoot = new URL(runningFromDist ? "../../" : "../", import.meta.url);

/** An absolute path inside the repository (or the installed app), whichever way the server runs. */
export function repoPath(relative: string): string {
  return fileURLToPath(new URL(relative, repoRoot));
}
