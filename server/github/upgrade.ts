import { randomBytes } from "node:crypto";
import { Type, type Static } from "typebox";
import type { Context } from "../context.js";
import { requireSecretBox } from "../encryption.js";
import { ApiError } from "../http/errors.js";
import { appToken, isAnyAdmin, requiredEvents, requiredPermissions, webhookSecret, webhooksPath } from "./app.js";
import { appInstallations, appOnGitHub, appWebhook, under } from "./client.js";

/**
 * The checklist for upgrading an App GitHub's manifest flow can't change, such as one created
 * for sign-in only: Cronk asks GitHub, as the App, what it has, and lists what it still lacks
 * for the Admin to add in the App's settings on GitHub. Installations keep the permissions
 * their owner accepted until the owner accepts the new ones, so those are listed too.
 */

const Permissions = Type.Record(Type.String(), Type.String(), {
  description: "Permissions by name, each with the access needed (always `read`).",
});

export const Checklist = Type.Object({
  /** The App's settings page on GitHub, where its permissions, events and webhook are edited. */
  settingsUrl: Type.String({ format: "uri" }),
  missingPermissions: Permissions,
  missingEvents: Type.Array(Type.String()),
  webhook: Type.Union([Type.Object({ url: Type.String({ format: "uri" }), secret: Type.String() }), Type.Null()], {
    description:
      "The webhook URL and secret to paste into the App's settings, or null once GitHub sends deliveries to Cronk signed with Cronk's secret. GitHub never shows a secret, so one Cronk made is listed until a delivery comes signed with it.",
  }),
  installationsNotAccepted: Type.Array(
    Type.Object({ account: Type.String(), htmlUrl: Type.String({ format: "uri" }), missingPermissions: Permissions }),
  ),
});
export type Checklist = Static<typeof Checklist>;

/** Permissions an installation has accepted for itself; `emails` belongs to each User's sign-in instead. */
const installationPermissions = Object.keys(requiredPermissions).filter((name) => name !== "emails");

function missingOf(has: Record<string, string> | undefined, names: string[]): Record<string, string> {
  const missing: Record<string, string> = {};
  // Any access, such as `write` granted by hand, includes reading.
  for (const name of names) if (!has?.[name] || has[name] === "none") missing[name] = requiredPermissions[name]!;
  return missing;
}

/** Cronk's webhook secret for the App, made now if the App was created without one. */
async function secretToPaste(context: Context): Promise<string> {
  // Only the first of two Admins looking at once stores theirs; both then read the same one.
  await context.db.query("update github_app set webhook_secret = $1 where webhook_secret is null", [
    requireSecretBox(context.config).seal(randomBytes(32).toString("hex")),
  ]);
  return (await webhookSecret(context))!.secret;
}

export async function checklist(context: Context, userId: string): Promise<Checklist> {
  const { config } = context;
  if (!(await isAnyAdmin(context.db, userId))) {
    throw new ApiError(403, "not_admin", "Only an Admin can see what the GitHub App lacks, since that includes its webhook secret.");
  }
  const jwt = await appToken(context);
  const [app, hook, installations] = await Promise.all([
    appOnGitHub(config, jwt),
    appWebhook(config, jwt),
    appInstallations(config, jwt),
  ]);
  const url = `${config.publicUrl.origin}${webhooksPath}`;
  const missingPermissions = missingOf(app.permissions, Object.keys(requiredPermissions));
  const signedWithOurs = hook?.hasSecret && (await webhookSecret(context))?.confirmed;
  // An installation's owner can accept only what the App itself asks for.
  const askedOfInstallations = installationPermissions.filter((name) => !missingPermissions[name]);
  const settingsPath =
    app.owner.type === "Organization"
      ? `/organizations/${encodeURIComponent(app.owner.login)}/settings/apps/${encodeURIComponent(app.slug)}`
      : `/settings/apps/${encodeURIComponent(app.slug)}`;
  return {
    settingsUrl: under(config.github.url, settingsPath).toString(),
    missingPermissions,
    missingEvents: requiredEvents.filter((event) => !app.events?.includes(event)),
    webhook: hook?.url === url && signedWithOurs ? null : { url, secret: await secretToPaste(context) },
    installationsNotAccepted: installations
      .map((i) => ({ account: i.account.login, htmlUrl: i.html_url, missingPermissions: missingOf(i.permissions, askedOfInstallations) }))
      .filter((i) => Object.keys(i.missingPermissions).length > 0),
  };
}
