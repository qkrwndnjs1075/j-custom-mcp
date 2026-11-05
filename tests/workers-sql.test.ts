import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import type { DurableObjectStorage } from "@cloudflare/workers-types";
import { AuthTokenStore } from "../src/auth-token-store";
import { BookingStore } from "../src/booking-store";
import type { SqlValue } from "../src/sql-database";
import { UserStore } from "../src/user-store";
import { UserVault } from "../src/user-vault";
import { WatchStore } from "../src/watch-store";
import {
  DurableSqlDatabase,
  type DurableSqlStorage,
  DurableStorageError,
} from "../src/workers/sql-database";
import { DurableStateStorage } from "../src/workers/state-storage";

const opened: Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
});

function storage() {
  const db = new Database(":memory:", { strict: true });
  db.exec("PRAGMA foreign_keys=ON");
  opened.push(db);
  const durable: DurableSqlStorage = {
    sql: {
      exec<Row extends Record<string, SqlValue>>(sql: string, ...bindings: SqlValue[]) {
        // Bun prepares only the first statement; schema scripts use its script API.
        if (/^\s*CREATE\b/i.test(sql) && bindings.length === 0) {
          db.exec(sql);
          return { toArray: (): Row[] => [] };
        }
        const rows = db.query<Row, SqlValue[]>(sql).all(...bindings);
        return { toArray: () => rows };
      },
    },
    transactionSync: (fn) => db.transaction(fn).immediate(),
  };
  return { db, durable };
}

// Compile-time contract: a real Durable Object storage needs no cast or wrapper.
export function acceptsDurableObjectStorage(storage: DurableObjectStorage): DurableSqlDatabase {
  return new DurableSqlDatabase(storage, "accounts");
}

test("namespaces preserve independent owners, partial indexes and existing store schemas", () => {
  const { db, durable } = storage();
  const a = `u_${"a".repeat(64)}`;
  const b = `u_${"b".repeat(64)}`;
  new BookingStore(new DurableSqlDatabase(durable, `${a}_booking`), "alice");
  new BookingStore(new DurableSqlDatabase(durable, `${b}_booking`), "bob");
  new WatchStore(new DurableSqlDatabase(durable, `${a}_watch`));
  new WatchStore(new DurableSqlDatabase(durable, `${b}_watch`));
  new AuthTokenStore(new DurableSqlDatabase(durable, "oauth"));
  new UserStore({
    db: new DurableSqlDatabase(durable, "accounts"),
    vault: new UserVault(new Uint8Array(32)),
  });
  expect(
    db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type='index' AND name LIKE '%active_watch_key'",
      )
      .get()?.count,
  ).toBe(2);
  expect(() => new BookingStore(new DurableSqlDatabase(durable, `${a}_booking`), "bob")).toThrow();
  expect(
    db.query<{ count: number }, []>("SELECT count(*) AS count FROM oauth_oauth_clients").get()
      ?.count,
  ).toBe(0);
});

test("SQL mapping leaves literals and comments unchanged and rejects explicit external tables", () => {
  const { durable } = storage();
  const db = new DurableSqlDatabase(durable, "accounts");
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY, value TEXT)");
  db.query("INSERT INTO users VALUES(?,?)").run("id", "bound users value");
  const row = db
    .query<{ literal: string; value: string }, []>(
      "SELECT 'users; ''bookings''' AS literal, value FROM users -- oauth_tokens\n/* users */",
    )
    .get();
  expect(row).toEqual({ literal: "users; 'bookings'", value: "bound users value" });
  expect(() => db.query("SELECT * FROM oauth_oauth_tokens")).toThrow(DurableStorageError);
  expect(() => db.query("SELECT * FROM main.users")).toThrow(DurableStorageError);
  expect(() => db.query("PRAGMA foreign_keys=OFF")).toThrow(DurableStorageError);
  expect(() => new DurableSqlDatabase(durable, 'accounts";DROP TABLE users;--')).toThrow(
    DurableStorageError,
  );
});

test("mutation changes exclude cascading deletes and absent rows return null", () => {
  const { durable } = storage();
  const db = new DurableSqlDatabase(durable, "oauth");
  db.exec(`CREATE TABLE oauth_families(id TEXT PRIMARY KEY);
    CREATE TABLE oauth_tokens(id TEXT PRIMARY KEY, family TEXT REFERENCES oauth_families(id) ON DELETE CASCADE);`);
  db.query("INSERT INTO oauth_families VALUES(?)").run("family");
  db.query("INSERT INTO oauth_tokens VALUES(?,?)").run("first", "family");
  db.query("INSERT INTO oauth_tokens VALUES(?,?)").run("second", "family");
  expect(db.query("DELETE FROM oauth_families WHERE id=?").run("family").changes).toBe(1);
  expect(db.query("SELECT * FROM oauth_tokens").get()).toBeNull();
  expect(db.query("DELETE FROM oauth_families WHERE id=?").run("family").changes).toBe(0);
});

test("nested transactions roll back inner writes and preserve outer atomicity", () => {
  const { durable } = storage();
  const db = new DurableSqlDatabase(durable, "accounts");
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY)");
  db.transaction(() => {
    db.query("INSERT INTO users VALUES(?)").run("outer");
    expect(() =>
      db
        .transaction(() => {
          db.query("INSERT INTO users VALUES(?)").run("inner");
          throw new TypeError("rollback");
        })
        .immediate(),
    ).toThrow("rollback");
  }).immediate();
  expect(db.query<{ id: string }, []>("SELECT id FROM users").all()).toEqual([{ id: "outer" }]);
  expect(() =>
    db
      .transaction(() => {
        db.transaction(() => {
          db.query("INSERT INTO users VALUES(?)").run("nested");
        }).immediate();
        throw new TypeError("outer rollback");
      })
      .immediate(),
  ).toThrow("outer rollback");
  expect(db.query<{ id: string }, []>("SELECT id FROM users").all()).toEqual([{ id: "outer" }]);
});

test("encrypted state survives reopening without plaintext credentials in SQLite rows", () => {
  const { db: physical, durable } = storage();
  const db = new DurableSqlDatabase(durable, "accounts");
  const key = new Uint8Array(32).fill(7);
  const state = new DurableStateStorage(db, key, "connection");
  const snapshot = { token: "synthetic-secret-token", challenge: { value: "synthetic-challenge" } };
  state.set("snapshot", snapshot);
  expect(new DurableStateStorage(db, key, "connection").get("snapshot")).toEqual(snapshot);
  const raw = physical
    .query<{ ciphertext: string }, []>("SELECT ciphertext FROM accounts_runtime_state")
    .get();
  expect(raw?.ciphertext).not.toContain("synthetic");
  expect(new DurableStateStorage(db, key, "other").get("snapshot")).toBeUndefined();
  state.delete("snapshot");
  expect(state.get("snapshot")).toBeUndefined();
});

for (const corruption of ["scope", "slot", "key", "envelope"] as const) {
  test(`encrypted state rejects ${corruption} substitution`, () => {
    const { durable } = storage();
    const db = new DurableSqlDatabase(durable, "accounts");
    const key = new Uint8Array(32).fill(7);
    const state = new DurableStateStorage(db, key, "original");
    state.set("first", { secret: "private" });
    switch (corruption) {
      case "scope":
        db.query("UPDATE runtime_state SET scope=?").run("other");
        expect(() => new DurableStateStorage(db, key, "other").get("first")).toThrow(
          DurableStorageError,
        );
        break;
      case "slot":
        db.query("UPDATE runtime_state SET slot=?").run("second");
        expect(() => state.get("second")).toThrow(DurableStorageError);
        break;
      case "key":
        expect(() =>
          new DurableStateStorage(db, new Uint8Array(32).fill(8), "original").get("first"),
        ).toThrow(DurableStorageError);
        break;
      case "envelope":
        db.query("UPDATE runtime_state SET ciphertext=?").run("v1.YQ==");
        expect(() => state.get("first")).toThrow(DurableStorageError);
        break;
      default: {
        const exhaustive: never = corruption;
        throw exhaustive;
      }
    }
  });
}
