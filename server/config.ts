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
}

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
  };
}
