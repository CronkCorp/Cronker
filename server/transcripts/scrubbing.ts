/**
 * Scrubbing: known secret patterns in a Transcript become `[scrubbed]` before anything is stored (ADR 0006). The
 * list is fixed in code: Cronk's own tokens, GitHub's, Anthropic's, AWS access keys, Slack's, private-key blocks
 * and bearer values. A secret of another shape is not caught, which is why any User may delete a Transcript.
 */

export const scrubbed = "[scrubbed]";

// The distinctive prefixes match even straight after other letters, such as a token pasted onto a word.
const patterns: RegExp[] = [
  // Cronk's own secrets: `cronk_<kind>_` and 32 random bytes in base64url (server/identity/secrets.ts),
  // caught whole however much more of the same alphabet follows.
  /cronk_(?:setup|sign_in|join|reset|github_state|github_sign_in|agent|oauth_code|oauth_refresh)_[A-Za-z0-9_-]{32,}/g,
  // GitHub: personal, OAuth, user-to-server, server-to-server and refresh tokens, and fine-grained personal tokens.
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  // Anthropic API and admin keys.
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // AWS access key ids, long-lived and temporary.
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Slack bot, user, app-level, refresh and configuration tokens.
  /xox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  // A PEM private-key block, or its start to the end of the text when its end was never printed.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----|[\s\S]*$)/g,
];

/** A bearer value: what follows `Bearer`, when it reads as a token (with a digit, 8 characters or more). */
const bearer = /\b(Bearer\s+)(?=[A-Za-z0-9._~+/-]*\d)[A-Za-z0-9._~+/-]{8,}=*/gi;

/** The text with every known secret replaced by `[scrubbed]`. */
export function scrubText(text: string): string {
  let result = text;
  for (const pattern of patterns) result = result.replace(pattern, scrubbed);
  return result.replace(bearer, `$1${scrubbed}`);
}

/** A JSON value with every string in it scrubbed, keys included. */
export function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrubValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [scrubText(key), scrubValue(inner)]));
  }
  return value;
}
