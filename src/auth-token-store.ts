import type { AuthInfo } from "@modelcontextprotocol/server";
import { openOAuthDatabase } from "./oauth-database";
import { OAuthRequestStore } from "./oauth-request-store";
import { OAuthServiceError, oauthDigest, oauthSecret } from "./oauth-types";
import type { SyncDatabase } from "./sql-database";
import { type UserId, UserIdSchema } from "./user-types";

type TokenRow = {
  readonly family: string;
  readonly user_id: string;
  readonly client_id: string;
  readonly resource: string;
  readonly expires: number;
  readonly used: number;
  readonly revoked: number;
  readonly family_expires: number;
};
export type OAuthTokenPair = {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: "mcp";
};
const lookupSql = `SELECT t.family,t.user_id,t.client_id,t.resource,t.expires,t.used,
  f.revoked,f.expires AS family_expires FROM oauth_tokens t JOIN oauth_families f ON f.id=t.family
  WHERE t.hash=? AND t.kind=?`;

export class AuthTokenStore {
  readonly #db: SyncDatabase;
  readonly requests: OAuthRequestStore;
  constructor(path: string | SyncDatabase) {
    this.#db = openOAuthDatabase(path);
    this.requests = new OAuthRequestStore(this.#db);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS oauth_families(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS oauth_tokens(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,family TEXT NOT NULL REFERENCES oauth_families(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,client_id TEXT NOT NULL,resource TEXT NOT NULL,expires INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS oauth_token_owner ON oauth_families(user_id);`);
  }

  exchangeCode(
    input: {
      readonly code: string;
      readonly clientId: string;
      readonly redirectUri: string;
      readonly resource: string;
      readonly verifier: string;
    },
    now: number,
  ): OAuthTokenPair {
    return this.#safe(() =>
      this.#db
        .transaction(() => {
          this.#cleanup(now);
          const user = this.requests.exchange(input, now);
          const family = crypto.randomUUID();
          this.#db
            .query("INSERT INTO oauth_families(id,user_id,expires) VALUES(?,?,?)")
            .run(family, user, now + 2_592_000);
          return this.#issue(user, input.clientId, input.resource, family, now + 2_592_000, now);
        })
        .immediate(),
    );
  }

  rotate(refreshToken: string, clientId: string, resource: string, now: number): OAuthTokenPair {
    const outcome = this.#safe(() =>
      this.#db
        .transaction(() => {
          const row = this.#db
            .query<TokenRow, [string, string]>(lookupSql)
            .get(oauthDigest(refreshToken), "refresh");
          if (
            !row ||
            row.revoked ||
            row.expires <= now ||
            row.family_expires <= now ||
            row.client_id !== clientId ||
            row.resource !== resource
          )
            return null;
          if (row.used) {
            this.#db.query("UPDATE oauth_families SET revoked=1 WHERE id=?").run(row.family);
            return null;
          }
          this.#cleanup(now);
          this.#db
            .query("UPDATE oauth_tokens SET used=1 WHERE hash=?")
            .run(oauthDigest(refreshToken));
          return this.#issue(
            UserIdSchema.parse(row.user_id),
            clientId,
            resource,
            row.family,
            row.family_expires,
            now,
          );
        })
        .immediate(),
    );
    if (!outcome) throw new OAuthServiceError("invalid_grant");
    return outcome;
  }

  verify(accessToken: string, resource: string, now: number): AuthInfo {
    return this.#safe(() => {
      const row = this.#db
        .query<TokenRow, [string, string]>(lookupSql)
        .get(oauthDigest(accessToken), "access");
      if (
        !row ||
        row.revoked ||
        row.expires <= now ||
        row.family_expires <= now ||
        row.resource !== resource
      )
        throw new OAuthServiceError("invalid_token");
      return {
        token: accessToken,
        clientId: row.client_id,
        scopes: ["mcp"],
        expiresAt: row.expires,
        resource: new URL(row.resource),
        extra: { subject: UserIdSchema.parse(row.user_id) },
      };
    });
  }

  revoke(token: string, clientId?: string): void {
    this.#safe(() => {
      const row = this.#db
        .query<{ family: string; client_id: string }, [string]>(
          "SELECT family,client_id FROM oauth_tokens WHERE hash=?",
        )
        .get(oauthDigest(token));
      if (row && (clientId === undefined || row.client_id === clientId))
        this.#db.query("UPDATE oauth_families SET revoked=1 WHERE id=?").run(row.family);
    });
  }

  disconnectUser(userId: UserId): void {
    this.#safe(() =>
      this.#db
        .transaction(() => {
          const subject = UserIdSchema.parse(userId);
          this.#db.query("UPDATE oauth_families SET revoked=1 WHERE user_id=?").run(subject);
          this.#db.query("DELETE FROM oauth_codes WHERE user_id=?").run(subject);
        })
        .immediate(),
    );
  }
  close(): void {
    this.#db.close();
  }

  #issue(
    user: UserId,
    clientId: string,
    resource: string,
    family: string,
    expires: number,
    now: number,
  ): OAuthTokenPair {
    const access = oauthSecret();
    const refresh = oauthSecret();
    const accessExpires = Math.min(now + 3600, expires);
    const insert = this.#db.query(
      "INSERT INTO oauth_tokens(hash,kind,family,user_id,client_id,resource,expires) VALUES(?,?,?,?,?,?,?)",
    );
    insert.run(oauthDigest(access), "access", family, user, clientId, resource, accessExpires);
    insert.run(oauthDigest(refresh), "refresh", family, user, clientId, resource, expires);
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: accessExpires - now,
      scope: "mcp",
    };
  }
  #cleanup(now: number): void {
    this.#db.query("DELETE FROM oauth_families WHERE expires<=?").run(now);
    this.#db.query("DELETE FROM oauth_tokens WHERE kind='access' AND expires<=?").run(now);
    const count = this.#db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_tokens").get();
    if (!count || count.n > 9998) throw new OAuthServiceError("temporarily_unavailable");
  }
  #safe<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof OAuthServiceError) throw error;
      throw new OAuthServiceError("temporarily_unavailable");
    }
  }
}
