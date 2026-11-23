import { resolve } from "node:path";

/** Cronk's configuration, read only from environment variables. */
export interface Config {
  /** The public HTTPS address Cronk is reached at, e.g. `https://cronk.example.com`. */
  publicUrl: URL;
  databaseUrl: string;
  host: string;
  port: number;
  /** Directory of the built web client; when unset, the web client is not served. */
  webRoot?: string;
  /** The key secrets Cronk keeps (such as the GitHub App's credentials) are encrypted with. */
  secretKey?: string;
  /** Where GitHub is: its web address (`https://github.com`) and its API's (`https://api.github.com`). */
  github: { url: URL; apiUrl: URL };
  /** Where the Claude API is, whose scheduled-task fire endpoint the subscription Runner calls (`https://api.anthropic.com`). */
  claudeApiUrl: URL;
  /** Where the Claude API's Managed Agents endpoints are, which the `managed_agents` Runner calls (`https://api.anthropic.com`). */
  managedAgentsApiUrl: URL;
  /** Where Attachments are kept, and how large each may be. */
  attachments: { directory: string; limitBytes: number };
  /**
   * Whether webhooks may be delivered to private, loopback and link-local addresses, such as a receiver on the LAN
   * (`CRONK_WEBHOOKS_ALLOW_PRIVATE=true`). Off by default, so a User's webhook can't reach the network Cronk runs in.
   */
  webhooks: { allowPrivate: boolean };
}

/** An Attachment may be this large unless configured otherwise: 25 MB. */
export const defaultAttachmentLimitMb = 25;

/** A megabyte as Attachment limits count it. */
export const megabyte = 1024 * 1024;

export class ConfigError extends Error {}

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} must be set`);
  return value;
}

function httpUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): URL {
  const value = env[name]?.trim() || fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a URL such as ${fallback}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new ConfigError(`${name} must be an http(s) URL`);
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv, defaults: { webRoot?: string } = {}): Config {
  let publicUrl: URL;
  try {
    publicUrl = new URL(required(env, "CRONK_PUBLIC_URL"));
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("CRONK_PUBLIC_URL must be a URL such as https://cronk.example.com");
  }
  if (publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && localHosts.has(publicUrl.hostname))) {
    throw new ConfigError("CRONK_PUBLIC_URL must use https (plain http is allowed only for localhost)");
  }
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new ConfigError("CRONK_PUBLIC_URL must be an origin with no path, such as https://cronk.example.com");
  }

  const port = Number(env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError("PORT must be a port number");

  const secretKey = env.CRONK_SECRET_KEY?.trim() || undefined;
  if (secretKey && secretKey.length < 32) {
    throw new ConfigError("CRONK_SECRET_KEY must be at least 32 characters, such as the output of `openssl rand -base64 32`");
  }

  const limitMb = Number(env.CRONK_ATTACHMENT_LIMIT_MB?.trim() || defaultAttachmentLimitMb);
  if (!Number.isFinite(limitMb) || limitMb <= 0) {
    throw new ConfigError("CRONK_ATTACHMENT_LIMIT_MB must be a number of megabytes above 0, such as 25");
  }

  const allowPrivate = env.CRONK_WEBHOOKS_ALLOW_PRIVATE?.trim().toLowerCase() || "false";
  if (allowPrivate !== "true" && allowPrivate !== "false") {
    throw new ConfigError("CRONK_WEBHOOKS_ALLOW_PRIVATE must be true or false");
  }

  return {
    publicUrl,
    databaseUrl: required(env, "DATABASE_URL"),
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    webRoot: env.CRONK_WEB_ROOT?.trim() || defaults.webRoot,
    secretKey,
    github: {
      url: httpUrl(env, "CRONK_GITHUB_URL", "https://github.com"),
      apiUrl: httpUrl(env, "CRONK_GITHUB_API_URL", "https://api.github.com"),
    },
    claudeApiUrl: httpUrl(env, "CRONK_CLAUDE_API_URL", "https://api.anthropic.com"),
    managedAgentsApiUrl: httpUrl(env, "CRONK_MANAGED_AGENTS_API_URL", "https://api.anthropic.com"),
    attachments: {
      directory: resolve(env.CRONK_ATTACHMENTS_DIR?.trim() || "data/attachments"),
      limitBytes: Math.floor(limitMb * megabyte),
    },
    webhooks: { allowPrivate: allowPrivate === "true" },
  };
}
