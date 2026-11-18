import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { Context } from "../context.js";
import type { Db } from "../db.js";

/**
 * OAuth clients of Cronk's MCP server. A client either registers itself (RFC 7591) and gets
 * an id Cronk made up, or uses the URL of its Client ID Metadata Document as its id, which
 * Cronk fetches whenever the client asks for an authorization. Every client is public: it
 * proves itself with PKCE, not a secret.
 */

export interface OAuthClient {
  id: string;
  name: string | null;
  redirectUris: string[];
}

/** A refusal in OAuth's own terms (RFC 6749 §5.2), with the HTTP status it goes with. */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly statusCode = 400,
  ) {
    super(description);
  }
}

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A redirect URI must be an absolute https URL without a fragment, or plain http to the client's own machine. */
function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  return url.protocol === "https:" || (url.protocol === "http:" && loopbackHosts.has(url.hostname));
}

/** What a client says of itself, at registration or in its metadata document. */
function parseMetadata(body: unknown): { name: string | null; redirectUris: string[] } {
  const metadata = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const { redirect_uris: redirectUris, client_name: name } = metadata;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new OAuthError("invalid_redirect_uri", "A client needs at least one redirect URI, in `redirect_uris`.");
  }
  const invalid = redirectUris.find((uri) => !validRedirectUri(uri));
  if (invalid !== undefined) {
    throw new OAuthError(
      "invalid_redirect_uri",
      `${JSON.stringify(invalid)} isn't a redirect URI Cronk accepts: it must be an https URL without a fragment, or http to localhost.`,
    );
  }
  if (name !== undefined && (typeof name !== "string" || name.length > 200)) {
    throw new OAuthError("invalid_client_metadata", "`client_name` must be a string of at most 200 characters.");
  }
  return { name: name?.trim() || null, redirectUris };
}

const clientFields = `id, name, redirect_uris as "redirectUris"`;

/** Registers a client (RFC 7591). Whatever it asks for, it becomes a public client using authorization codes with PKCE. */
export async function registerClient({ db, clock }: Context, body: unknown) {
  const { name, redirectUris } = parseMetadata(body);
  const now = clock.now();
  const id = `cronk_client_${randomBytes(16).toString("base64url")}`;
  await db.query(
    "insert into oauth_clients (id, name, redirect_uris, created_at, updated_at) values ($1, $2, $3, $4, $4)",
    [id, name, redirectUris, now],
  );
  return {
    client_id: id,
    client_id_issued_at: Math.floor(now.getTime() / 1000),
    ...(name === null ? {} : { client_name: name }),
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

/** A client Cronk already knows, by id. */
export async function findClient(db: Db, clientId: string): Promise<OAuthClient | undefined> {
  const { rows } = await db.query<OAuthClient>(`select ${clientFields} from oauth_clients where id = $1`, [clientId]);
  return rows[0];
}

/** Whether a client id is the URL of a Client ID Metadata Document rather than one Cronk issued. */
const isMetadataUrl = (clientId: string) => /^https?:\/\//i.test(clientId);

/**
 * The client a request for an authorization names: one that registered, or one whose Client
 * ID Metadata Document Cronk fetches afresh, keeping a copy for the steps that follow.
 */
export async function resolveClient(context: Context, clientId: string): Promise<OAuthClient> {
  if (!isMetadataUrl(clientId)) {
    const client = await findClient(context.db, clientId);
    if (!client) throw new OAuthError("invalid_client", "Cronk doesn't know that client. Register it first.");
    return client;
  }
  const url = await metadataDocumentUrl(context, clientId);
  const document = await fetchDocument(url);
  if (document.client_id !== clientId) {
    throw new OAuthError("invalid_client", "The client's metadata document names a different `client_id` from its own URL.");
  }
  const { name, redirectUris } = parseMetadata(document);
  const now = context.clock.now();
  await context.db.query(
    `insert into oauth_clients (id, name, redirect_uris, created_at, updated_at) values ($1, $2, $3, $4, $4)
     on conflict (id) do update set name = excluded.name, redirect_uris = excluded.redirect_uris, updated_at = excluded.updated_at`,
    [clientId, name, redirectUris, now],
  );
  return { id: clientId, name, redirectUris };
}

/**
 * A Client ID Metadata Document's URL must be https with a path. A Cronk reached over plain
 * http, which only a local one may be, also takes plain http. Otherwise it never fetches from
 * its own network: the host must not be, or resolve to, a loopback or private address.
 */
async function metadataDocumentUrl({ config }: Context, clientId: string): Promise<URL> {
  const refuse = (why: string) => new OAuthError("invalid_client", `That client id isn't a usable metadata document URL: ${why}.`);
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw refuse("it isn't a URL");
  }
  const local = config.publicUrl.protocol === "http:";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw refuse("it must use https");
  if (url.pathname === "/" || url.hash || url.username || url.password) throw refuse("it needs a path, and no fragment or credentials");
  if (!local) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (addresses.length === 0) throw refuse("its host can't be found");
    if (addresses.some(isPrivateAddress)) throw refuse("its host is on a private network");
  }
  return url;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  const [a, b] = address.split(".").map(Number) as [number, number];
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  );
}

const documentLimitBytes = 64 * 1024;

async function fetchDocument(url: URL): Promise<Record<string, unknown>> {
  const unusable = (why: string) => new OAuthError("invalid_client", `Cronk couldn't use the client's metadata document: ${why}.`);
  let response: Response;
  try {
    response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" } });
  } catch {
    throw unusable("it couldn't be fetched");
  }
  if (!response.ok || !response.body) throw unusable(`fetching it answered ${response.status}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > documentLimitBytes) throw unusable("it is larger than 64 KB");
    chunks.push(chunk);
  }
  try {
    const document = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (typeof document === "object" && document !== null && !Array.isArray(document)) return document as Record<string, unknown>;
  } catch {
    // Reported below.
  }
  throw unusable("it isn't a JSON object");
}
