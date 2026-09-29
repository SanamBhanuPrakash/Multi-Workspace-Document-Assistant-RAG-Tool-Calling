import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../env";

/**
 * AES-256-GCM envelope for integration secrets (webhook URLs).
 *
 * The ciphertext is bound to its row through AAD (`workspaceId:kind`): copying one workspace's ciphertext into another
 * workspace's row (a tenancy attack, or a bug) makes decryption FAIL instead of leaking the secret across tenants.
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). A fresh 96-bit random IV is used for every encryption.
 */
const VERSION = "v1";

const key = (): Buffer => Buffer.from(env().ENCRYPTION_KEY, "base64");

export function seal(plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function open(sealed: string, aad: string): string {
  const [version, iv, tag, ct] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !ct) throw new Error("unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
