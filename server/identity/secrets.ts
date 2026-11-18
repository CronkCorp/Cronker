import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets Cronk issues: a recognisable `cronk_<kind>_` prefix, so a leaked one is easy
 * to spot and scan for, then 32 random bytes. Cronk stores only their hashes.
 */
export type SecretKind = "setup" | "sign_in" | "join" | "reset" | "github_state" | "github_sign_in";

export function issueSecret(kind: SecretKind): string {
  return `cronk_${kind}_${randomBytes(32).toString("base64url")}`;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function secretMatches(secret: string, hash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
