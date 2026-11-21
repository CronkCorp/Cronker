import { Type } from "typebox";
import type { Tx } from "../db.js";
import { ApiError } from "../http/errors.js";

/**
 * Words the web client's own pages use as the first part of an address, which no Workspace slug may be, so that
 * `/<slug>/…` never stands for one of them. `migrations/0044_workspace_slugs.sql` keeps the same list.
 */
export const reservedSlugs = new Set([
  "workspaces",
  "projects",
  "tickets",
  "documents",
  "terms",
  "decisions",
  "artifacts",
  "transcripts",
  "password",
  "github",
  "runners",
  "link",
  "connect",
  "api",
  "assets",
  "mcp",
  "oauth",
  "hooks",
]);

export const WorkspaceSlug = Type.String({
  minLength: 1,
  maxLength: 40,
  pattern: "^[a-z0-9]+(-[a-z0-9]+)*$",
  description:
    "The Workspace's name in its web addresses, such as `acme` in `/acme/tickets/RP-12`: lower case letters and " +
    "digits with single dashes between words. Unique across the installation, and never changed once set.",
});

/** Whether a slug may name a new Workspace: not taken and not one of the web client's own words. */
async function isFree(tx: Tx, slug: string): Promise<boolean> {
  if (reservedSlugs.has(slug)) return false;
  const { rowCount } = await tx.query("select 1 from workspaces where slug = $1", [slug]);
  return rowCount === 0;
}

/**
 * The slug for a new Workspace: the one its creator chose, refused when it is taken, or else one made from its name,
 * with `-2`, `-3` and so on when that is taken. Locks the Workspaces' slugs until the transaction ends, so two
 * Workspaces created at once don't pick the same one.
 */
export async function slugForNewWorkspace(tx: Tx, name: string, chosen?: string): Promise<string> {
  await tx.query("lock table workspaces in share row exclusive mode");
  if (chosen !== undefined) {
    if (!(await isFree(tx, chosen))) {
      throw new ApiError(409, "workspace_slug_taken", `The slug ${chosen} is taken. Choose another.`);
    }
    return chosen;
  }
  const { rows } = await tx.query<{ slug: string }>("select slug_of($1) as slug", [name]);
  const base = rows[0]!.slug || "workspace";
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    // The suffix takes the place of the base's last characters, so the slug stays within 40.
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (await isFree(tx, candidate)) return candidate;
  }
}
