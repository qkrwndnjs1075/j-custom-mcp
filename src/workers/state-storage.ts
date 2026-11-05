import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SyncDatabase } from "../sql-database";
import type { StateStorage } from "../transient-state";
import { DurableStorageError } from "./sql-database";

export class DurableStateStorage implements StateStorage {
  readonly #key: Buffer;
  constructor(
    readonly db: SyncDatabase,
    key: Uint8Array,
    readonly scope: string,
  ) {
    if (key.byteLength !== 32 || scope.length === 0 || scope.length > 256) {
      throw new DurableStorageError("configuration");
    }
    this.#key = Buffer.from(key);
    db.exec(`CREATE TABLE IF NOT EXISTS runtime_state (
      scope TEXT NOT NULL, slot TEXT NOT NULL, ciphertext TEXT NOT NULL,
      PRIMARY KEY (scope, slot)
    );`);
  }

  get(slot: string): unknown | undefined {
    const row = this.db
      .query<{ ciphertext: string }, [string, string]>(
        "SELECT ciphertext FROM runtime_state WHERE scope=? AND slot=?",
      )
      .get(this.scope, slot);
    if (!row) return undefined;
    try {
      if (!/^v1\.[A-Za-z0-9+/]+={0,2}$/.test(row.ciphertext))
        throw new DurableStorageError("integrity");
      const bytes = Buffer.from(row.ciphertext.slice(3), "base64");
      if (bytes.length < 29 || bytes.toString("base64") !== row.ciphertext.slice(3))
        throw new DurableStorageError("integrity");
      const decipher = createDecipheriv("aes-256-gcm", this.#key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      decipher.setAAD(Buffer.from(JSON.stringify(["tmoney-runtime:v1", this.scope, slot])));
      const plain = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      const value: unknown = JSON.parse(plain.toString("utf8"));
      return value;
    } catch (error) {
      if (error instanceof DurableStorageError) throw error;
      throw new DurableStorageError("integrity");
    }
  }

  set(slot: string, value: unknown): void {
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      if (error instanceof TypeError) throw new DurableStorageError("configuration");
      throw error;
    }
    if (serialized === undefined) throw new DurableStorageError("configuration");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(["tmoney-runtime:v1", this.scope, slot])));
    const encrypted = Buffer.concat([cipher.update(serialized, "utf8"), cipher.final()]);
    const ciphertext = `v1.${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64")}`;
    this.db
      .query(`INSERT INTO runtime_state(scope,slot,ciphertext) VALUES(?,?,?)
      ON CONFLICT(scope,slot) DO UPDATE SET ciphertext=excluded.ciphertext`)
      .run(this.scope, slot, ciphertext);
  }

  delete(slot: string): void {
    this.db.query("DELETE FROM runtime_state WHERE scope=? AND slot=?").run(this.scope, slot);
  }
}
