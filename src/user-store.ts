import { z } from "zod";
import { localFileExists, openLocalDatabase } from "#local-runtime";
import type { GoCredentials } from "./go-credentials";
import { DEFAULT_SERVICE_LIMITS } from "./service-limits";
import type { SyncDatabase } from "./sql-database";
import {
  safeUserStorage,
  type UserConnection,
  type UserId,
  UserIdSchema,
  UserStoreError,
} from "./user-types";
import { parseCredentials, UserVault } from "./user-vault";

const rowSchema = z.object({
  user_id: UserIdSchema,
  revision: z.number().int().nonnegative().safe(),
  ciphertext: z.string().max(32_768).nullable(),
  connection_id: z.string().uuid().nullable(),
});
type Row = z.infer<typeof rowSchema>;
const connection = (row: Row): UserConnection => ({
  userId: row.user_id,
  revision: row.revision,
  connected: row.ciphertext !== null,
  connectionId: row.connection_id,
});

export class UserStore {
  readonly #db: SyncDatabase;
  readonly #vault: UserVault;
  readonly #accountLimit: number;

  constructor(
    path: string | { readonly db: SyncDatabase; readonly vault: UserVault },
    options: { readonly keyPath?: string; readonly accountLimit?: number } = {},
  ) {
    this.#accountLimit = options.accountLimit ?? DEFAULT_SERVICE_LIMITS.accounts;
    const opened = safeUserStorage(() => {
      if (path === ":memory:") throw new UserStoreError("configuration");
      const vault =
        typeof path === "string"
          ? new UserVault(options.keyPath ?? `${path}.key`, localFileExists(path))
          : path.vault;
      const db = typeof path === "string" ? openLocalDatabase(path, "users") : path.db;
      try {
        db.run(`CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY, member_hash TEXT NOT NULL UNIQUE,
            revision INTEGER NOT NULL, ciphertext TEXT, connection_id TEXT
          );
          CREATE TABLE IF NOT EXISTS vault_key (slot INTEGER PRIMARY KEY CHECK(slot=1), fingerprint TEXT NOT NULL);`);
        db.transaction(() => {
          const row = db
            .query<{ readonly fingerprint: string }, []>(
              "SELECT fingerprint FROM vault_key WHERE slot=1",
            )
            .get();
          if (row && row.fingerprint !== vault.fingerprint())
            throw new UserStoreError("configuration");
          if (!row) db.query("INSERT INTO vault_key VALUES (1,?)").run(vault.fingerprint());
        }).immediate();
        return { db, vault };
      } catch (error) {
        db.close();
        throw error;
      }
    });
    this.#db = opened.db;
    this.#vault = opened.vault;
  }

  // Only the server's verified GO authentication completion may call connect.
  connect(input: GoCredentials): UserConnection & { readonly connectionId: string } {
    return safeUserStorage(() => {
      const credentials = parseCredentials(input);
      const hash = this.#vault.identity(credentials.moappMbrsSno);
      return this.#db
        .transaction(() => {
          const existing = this.#db
            .query<Row, [string]>("SELECT * FROM users WHERE member_hash=?")
            .get(hash);
          const old = existing ? rowSchema.parse(existing) : undefined;
          if (!old) {
            const count =
              this.#db
                .query<{ readonly count: number }, []>("SELECT COUNT(*) AS count FROM users")
                .get()?.count ?? 0;
            if (count >= this.#accountLimit) throw new UserStoreError("capacity");
          }
          const userId = old?.user_id ?? UserIdSchema.parse(crypto.randomUUID());
          const revision = (old?.revision ?? 0) + 1;
          const connectionId = crypto.randomUUID();
          const encrypted = this.#vault.encrypt(userId, revision, credentials);
          this.#db
            .query(`INSERT INTO users VALUES (?,?,?,?,?) ON CONFLICT(member_hash)
          DO UPDATE SET revision=excluded.revision,ciphertext=excluded.ciphertext,connection_id=excluded.connection_id`)
            .run(userId, hash, revision, encrypted, connectionId);
          return { userId, revision, connected: true, connectionId };
        })
        .immediate();
    });
  }

  status(userId: UserId): UserConnection | undefined {
    return safeUserStorage(() => {
      const row = this.#row(userId);
      return row ? connection(row) : undefined;
    });
  }

  list(): readonly UserConnection[] {
    return safeUserStorage(() =>
      this.#db
        .query<Row, []>("SELECT * FROM users")
        .all()
        .map((row) => connection(rowSchema.parse(row))),
    );
  }

  read(userId: UserId): {
    readonly credentials: GoCredentials;
    readonly revision: number;
    readonly connectionId: string;
  } {
    return safeUserStorage(() => {
      const row = this.#row(userId);
      if (!row || row.ciphertext === null || row.connection_id === null)
        throw new UserStoreError("disconnected");
      return {
        credentials: this.#vault.decrypt(userId, row.revision, row.ciphertext),
        revision: row.revision,
        connectionId: row.connection_id,
      };
    });
  }

  update(userId: UserId, expectedRevision: number, input: GoCredentials): boolean {
    return safeUserStorage(() => {
      const credentials = parseCredentials(input);
      const row = this.#row(userId);
      if (!row || row.ciphertext === null || row.revision !== expectedRevision) return false;
      const previous = this.#vault.decrypt(userId, row.revision, row.ciphertext);
      if (
        credentials.uuid !== previous.uuid ||
        credentials.busUserNumber !== previous.busUserNumber
      )
        return false;
      const ciphertext = this.#vault.encrypt(userId, expectedRevision + 1, credentials);
      return (
        this.#db
          .query(`UPDATE users SET ciphertext=?,revision=revision+1
        WHERE user_id=? AND revision=? AND ciphertext IS NOT NULL AND member_hash=?`)
          .run(ciphertext, userId, expectedRevision, this.#vault.identity(credentials.moappMbrsSno))
          .changes === 1
      );
    });
  }

  disconnect(userId: UserId): UserConnection {
    return safeUserStorage(() =>
      this.#db
        .transaction(() => {
          this.#db
            .query(
              "UPDATE users SET ciphertext=NULL,connection_id=NULL,revision=revision+1 WHERE user_id=?",
            )
            .run(userId);
          const row = this.#row(userId);
          if (!row) throw new UserStoreError("disconnected");
          return connection(row);
        })
        .immediate(),
    );
  }

  #row(userId: UserId): Row | undefined {
    const row = this.#db.query<Row, [string]>("SELECT * FROM users WHERE user_id=?").get(userId);
    return row ? rowSchema.parse(row) : undefined;
  }

  close(): void {
    this.#db.close();
  }
}
