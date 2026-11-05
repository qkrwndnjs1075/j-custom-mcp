import type { SqlValue, SyncDatabase, SyncStatement } from "../sql-database";

export interface DurableSqlStorage {
  readonly sql: {
    exec<Row extends Record<string, SqlValue>>(
      query: string,
      ...bindings: SqlValue[]
    ): { toArray(): Row[] };
  };
  transactionSync<T>(closure: () => T): T;
}

export class DurableStorageError extends Error {
  override readonly name = "DurableStorageError";
  constructor(readonly code: "configuration" | "integrity") {
    super(`Durable storage ${code} error`);
  }
}

const schemaIdentifiers = new Set([
  "users",
  "vault_key",
  "oauth_clients",
  "oauth_pending",
  "oauth_codes",
  "oauth_families",
  "oauth_tokens",
  "oauth_token_owner",
  "bookings",
  "booking_owner",
  "watches",
  "alerts",
  "active_watch_key",
  "cancellation_quotes",
  "cancellations",
  "runtime_state",
]);
const forbidden = new Set([
  "PRAGMA",
  "ATTACH",
  "DETACH",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

type Token = { readonly text: string; readonly kind: "identifier" | "literal" | "other" };

function namespaceSql(sql: string, namespace: string): string {
  const tokens: Token[] = [];
  const pattern =
    /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|\s+|./g;
  for (const match of sql.matchAll(pattern)) {
    const text = match[0];
    if (/^\s|^--|^\/\*/.test(text)) tokens.push({ text, kind: "other" });
    else if (text.startsWith("'")) tokens.push({ text, kind: "literal" });
    else if (/^[A-Za-z_"`[]/.test(text)) tokens.push({ text, kind: "identifier" });
    else tokens.push({ text, kind: "other" });
  }
  let expectsTable = false;
  let indexDefinition = false;
  let previous = "";
  let tableJustRead = false;
  return tokens
    .map(({ text, kind }) => {
      if (/^\s|^--|^\/\*/.test(text)) return text;
      if (kind === "literal") {
        previous = "literal";
        return text;
      }
      if (kind === "other") {
        if (text === "." && tableJustRead) throw new DurableStorageError("configuration");
        tableJustRead = false;
        if (text === ";") {
          expectsTable = false;
          indexDefinition = false;
        }
        if (text === "(" && expectsTable) expectsTable = false;
        previous = text;
        return text;
      }
      const name = /^["`[]/.test(text) ? text.slice(1, -1) : text;
      const upper = name.toUpperCase();
      const lower = name.toLowerCase();
      if (forbidden.has(upper) || lower.startsWith("sqlite_"))
        throw new DurableStorageError("configuration");
      if (
        !schemaIdentifiers.has(lower) &&
        /^(?:accounts_|oauth_|u_[a-f0-9]{64}_(?:booking|watch)_)/.test(lower)
      ) {
        throw new DurableStorageError("configuration");
      }
      if (expectsTable && ["IF", "NOT", "EXISTS"].includes(upper)) return text;
      if (expectsTable) {
        if (!schemaIdentifiers.has(lower)) throw new DurableStorageError("configuration");
        expectsTable = false;
        tableJustRead = true;
      } else {
        tableJustRead = false;
        if (upper === "INDEX") indexDefinition = true;
        if (
          ["TABLE", "INDEX", "FROM", "JOIN", "REFERENCES", "INTO"].includes(upper) ||
          (upper === "UPDATE" && previous !== "DO") ||
          (upper === "ON" && indexDefinition)
        )
          expectsTable = true;
      }
      previous = upper;
      return schemaIdentifiers.has(lower) ? `"${namespace}_${lower}"` : text;
    })
    .join("");
}

export class DurableSqlDatabase implements SyncDatabase {
  constructor(
    readonly storage: DurableSqlStorage,
    readonly namespace: string,
  ) {
    if (!/^(?:accounts|oauth|u_[a-f0-9]{64}_(?:booking|watch))$/.test(namespace)) {
      throw new DurableStorageError("configuration");
    }
  }

  query<Row extends Record<string, SqlValue>, Params extends SqlValue[]>(
    sql: string,
  ): SyncStatement<Row, Params> {
    const statement = namespaceSql(sql, this.namespace);
    const execute = (params: Params): Row[] => {
      if (params.some((value) => typeof value === "number" && !Number.isFinite(value))) {
        throw new DurableStorageError("configuration");
      }
      return this.storage.sql.exec<Row>(statement, ...params).toArray();
    };
    return {
      get: (...params) => execute(params)[0] ?? null,
      all: (...params) => execute(params),
      run: (...params) => {
        execute(params);
        const row = this.storage.sql
          .exec<{ changes: number }>("SELECT changes() AS changes")
          .toArray()[0];
        if (!row || !Number.isSafeInteger(row.changes) || row.changes < 0)
          throw new DurableStorageError("integrity");
        return { changes: row.changes };
      },
    };
  }

  exec(sql: string): void {
    this.storage.sql.exec(namespaceSql(sql, this.namespace)).toArray();
  }

  run(sql: string): void {
    this.exec(sql);
  }

  transaction<T>(fn: () => T): { immediate(): T } {
    return { immediate: () => this.storage.transactionSync(fn) };
  }

  close(): void {
    // The Durable Object owns the shared database lifecycle.
  }
}
