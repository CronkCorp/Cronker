/** Cronk's configuration, read only from environment variables. */
export interface Config {
  /** The public HTTPS address Cronk is reached at, e.g. `https://cronk.example.com`. */
  publicUrl: URL;
  databaseUrl: string;
  host: string;
  port: number;
  /** Directory of the built web client; when unset, the web client is not served. */
  webRoot?: string;
}

export class ConfigError extends Error {}

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} must be set`);
  return value;
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

  return {
    publicUrl,
    databaseUrl: required(env, "DATABASE_URL"),
    host: env.HOST?.trim() || "0.0.0.0",
    port,
    webRoot: env.CRONK_WEB_ROOT?.trim() || defaults.webRoot,
  };
}
