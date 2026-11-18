import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { ApiError } from "./http/errors.js";

/**
 * Secrets Cronk must keep readable, such as the GitHub App's credentials, are stored
 * encrypted with AES-256-GCM under a key derived from `CRONK_SECRET_KEY`, so a copy of
 * the database alone gives none of them away. Sealed text is `v1.<iv>.<tag>.<ciphertext>`,
 * each part in base64url.
 */
export interface SecretBox {
  seal(plaintext: string): string;
  open(sealed: string): string;
}

export function secretBox(key: string): SecretBox {
  const aesKey = createHash("sha256").update(`cronk secret box\0${key}`).digest();
  return {
    seal(plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["v1", iv, cipher.getAuthTag(), ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
    },
    open(sealed) {
      const [version, iv, tag, ciphertext] = sealed.split(".");
      if (version !== "v1" || !iv || !tag || ciphertext === undefined) throw new Error("not a sealed secret");
      const decipher = createDecipheriv("aes-256-gcm", aesKey, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    },
  };
}

/** The installation's SecretBox, or a refusal saying `CRONK_SECRET_KEY` must be set first. */
export function requireSecretBox(config: Config): SecretBox {
  if (!config.secretKey) {
    throw new ApiError(
      409,
      "no_secret_key",
      "Cronk has no CRONK_SECRET_KEY to encrypt secrets with. Whoever runs Cronk must set it and restart Cronk first.",
    );
  }
  return secretBox(config.secretKey);
}
