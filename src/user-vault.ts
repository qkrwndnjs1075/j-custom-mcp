import { loadVaultKey } from "#local-runtime";

export { privateVaultFile } from "#local-runtime";

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { type GoCredentials, GoCredentialsSchema } from "./go-credential-types";
import { type UserId, UserStoreError } from "./user-types";

export class UserVault {
  readonly #key: Buffer;
  constructor(key: string | Uint8Array, existingDatabase = false) {
    const bytes = typeof key === "string" ? loadVaultKey(key, existingDatabase) : key;
    if (bytes.byteLength !== 32) throw new UserStoreError("configuration");
    this.#key = Buffer.from(bytes);
  }

  identity(member: string): string {
    return createHmac("sha256", this.#key).update(`tmoney-member:v1:${member}`).digest("hex");
  }

  fingerprint(): string {
    return createHmac("sha256", this.#key).update("tmoney-vault-key:v1").digest("hex");
  }

  encrypt(userId: UserId, revision: number, credentials: GoCredentials): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`${userId}:${revision}`));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64");
  }

  decrypt(userId: UserId, revision: number, encoded: string): GoCredentials {
    try {
      if (encoded.length > 32_768) throw new UserStoreError("integrity");
      const bytes = Buffer.from(encoded, "base64");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(Buffer.from(`${userId}:${revision}`));
      const plaintext = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      const value: unknown = JSON.parse(plaintext.toString("utf8"));
      return parseCredentials(value);
    } catch {
      throw new UserStoreError("integrity");
    }
  }
}

export function parseCredentials(value: unknown): GoCredentials {
  const parsed = GoCredentialsSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 16_384) {
    throw new UserStoreError("configuration");
  }
  return parsed.data;
}
