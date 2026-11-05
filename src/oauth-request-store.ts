import { z } from "zod";
import {
  type OAuthClient,
  OAuthClientSchema,
  OAuthServiceError,
  oauthDigest,
  oauthSecret,
} from "./oauth-types";
import type { SyncDatabase } from "./sql-database";
import { type UserId, UserIdSchema } from "./user-types";

const pendingSchema = z.object({
  clientId: z.string(),
  redirectUri: z.string(),
  resource: z.string(),
  challenge: z.string(),
  scope: z.string(),
  state: z.string(),
  expiresAt: z.number(),
});
export type OAuthPending = z.infer<typeof pendingSchema>;
type PendingRow = { readonly data: string; readonly binding: string | null };
type CodeRow = { readonly data: string; readonly user_id: string; readonly expires: number };

export class OAuthRequestStore {
  readonly #db: SyncDatabase;
  constructor(db: SyncDatabase) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_pending(hash TEXT PRIMARY KEY, data TEXT NOT NULL, binding TEXT, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY, data TEXT NOT NULL, user_id TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }

  register(client: OAuthClient): void {
    this.#db
      .transaction(() => {
        const count = this.#db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_clients")
          .get();
        if (!count || count.n >= 1000) throw new OAuthServiceError("temporarily_unavailable");
        this.#db
          .query("INSERT INTO oauth_clients(id,data) VALUES(?,?)")
          .run(client.client_id, JSON.stringify(client));
      })
      .immediate();
  }

  client(id: string): OAuthClient {
    const row = this.#db
      .query<{ data: string }, [string]>("SELECT data FROM oauth_clients WHERE id=?")
      .get(id);
    if (!row) throw new OAuthServiceError("invalid_client");
    return OAuthClientSchema.parse(JSON.parse(row.data));
  }

  createPending(input: OAuthPending, now: number): string {
    return this.#db
      .transaction(() => {
        this.#db.query("DELETE FROM oauth_pending WHERE expires<=?").run(now);
        this.#db.query("DELETE FROM oauth_codes WHERE expires<=?").run(now);
        const count = this.#db
          .query<{ n: number }, []>(
            "SELECT (SELECT COUNT(*) FROM oauth_pending)+(SELECT COUNT(*) FROM oauth_codes) AS n",
          )
          .get();
        if (!count || count.n >= 1000) throw new OAuthServiceError("temporarily_unavailable");
        const id = oauthSecret();
        this.#db
          .query("INSERT INTO oauth_pending(hash,data,expires) VALUES(?,?,?)")
          .run(oauthDigest(id), JSON.stringify(input), input.expiresAt);
        return id;
      })
      .immediate();
  }

  claim(id: string, binding: string, now: number): OAuthPending {
    return this.#db
      .transaction(() => {
        const hash = oauthDigest(id);
        const row = this.#db
          .query<PendingRow, [string, number]>(
            "SELECT data,binding FROM oauth_pending WHERE hash=? AND expires>?",
          )
          .get(hash, now);
        if (!row || (row.binding !== null && row.binding !== oauthDigest(binding)))
          throw new OAuthServiceError("invalid_request");
        this.#db
          .query("UPDATE oauth_pending SET binding=? WHERE hash=?")
          .run(oauthDigest(binding), hash);
        return pendingSchema.parse(JSON.parse(row.data));
      })
      .immediate();
  }

  complete(
    id: string,
    binding: string,
    userId: UserId,
    now: number,
  ): { readonly code: string; readonly pending: OAuthPending } {
    return this.#db
      .transaction(() => {
        const hash = oauthDigest(id);
        const row = this.#db
          .query<PendingRow, [string, number]>(
            "SELECT data,binding FROM oauth_pending WHERE hash=? AND expires>?",
          )
          .get(hash, now);
        if (!row || row.binding !== oauthDigest(binding))
          throw new OAuthServiceError("invalid_request");
        const pending = pendingSchema.parse(JSON.parse(row.data));
        const code = oauthSecret();
        this.#db.query("DELETE FROM oauth_pending WHERE hash=?").run(hash);
        this.#db
          .query("INSERT INTO oauth_codes(hash,data,user_id,expires) VALUES(?,?,?,?)")
          .run(oauthDigest(code), JSON.stringify(pending), UserIdSchema.parse(userId), now + 120);
        return { code, pending };
      })
      .immediate();
  }

  exchange(
    input: {
      readonly code: string;
      readonly clientId: string;
      readonly redirectUri: string;
      readonly resource: string;
      readonly verifier: string;
    },
    now: number,
  ): UserId {
    return this.#db
      .transaction(() => {
        const hash = oauthDigest(input.code);
        const row = this.#db
          .query<CodeRow, [string]>("SELECT data,user_id,expires FROM oauth_codes WHERE hash=?")
          .get(hash);
        if (!row || row.expires <= now) throw new OAuthServiceError("invalid_grant");
        const pending = pendingSchema.parse(JSON.parse(row.data));
        if (
          pending.clientId !== input.clientId ||
          pending.redirectUri !== input.redirectUri ||
          pending.resource !== input.resource ||
          pending.challenge !== oauthDigest(input.verifier)
        )
          throw new OAuthServiceError("invalid_grant");
        this.#db.query("DELETE FROM oauth_codes WHERE hash=?").run(hash);
        return UserIdSchema.parse(row.user_id);
      })
      .immediate();
  }
}
