import { openLocalDatabase } from "#local-runtime";
import type { SyncDatabase } from "./sql-database";
import { decodeStoredSpec } from "./watch-history";
import {
  type Observation,
  type StoredWatch,
  type Watch,
  type WatchState,
  watchDedupeKey,
} from "./watch-types";

export type WatchRow = {
  readonly id: string;
  readonly spec: string;
  readonly status: Watch["status"];
  readonly created_at: number;
  readonly expires_at: number;
  readonly next_check_at: number;
  readonly matched: number;
  readonly last_outcome: Observation["kind"] | null;
  readonly last_checked_at: number | null;
  readonly failures: number;
  readonly last_error: string | null;
};
export type AlertRow = {
  readonly id: number;
  readonly watch_id: string;
  readonly generated_at: number;
  readonly payload: string;
};
export function decodeWatch(row: WatchRow): StoredWatch {
  const decoded = decodeStoredSpec(JSON.parse(row.spec));
  const state: WatchState = {
    id: row.id,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    nextCheckAt: new Date(row.next_check_at).toISOString(),
    lastCheckedAt:
      row.last_checked_at === null ? null : new Date(row.last_checked_at).toISOString(),
    lastOutcome: row.last_outcome,
    consecutiveFailures: row.failures,
    lastError: row.last_error,
  };
  switch (decoded.schemaVersion) {
    case "current":
      return { ...decoded.spec, ...state };
    case "legacy":
      return { ...decoded.spec, ...state, schemaVersion: "legacy" };
    default: {
      const exhaustive: never = decoded;
      throw exhaustive;
    }
  }
}

export function decodeCurrentWatch(row: WatchRow): Watch {
  const watch = decodeWatch(row);
  if ("schemaVersion" in watch) throw new TypeError("Legacy watch cannot execute");
  return watch;
}

export function openWatchDatabase(path: string | SyncDatabase): SyncDatabase {
  const db = typeof path === "string" ? openLocalDatabase(path, "watch") : path;
  db.run(`CREATE TABLE IF NOT EXISTS watches (
        id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL, spec TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','cancelled','expired')),
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, next_check_at INTEGER NOT NULL,
        matched INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, last_checked_at INTEGER,
        failures INTEGER NOT NULL DEFAULT 0, last_error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS active_watch_key ON watches(dedupe_key) WHERE status='active';
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id TEXT NOT NULL,
        generated_at INTEGER NOT NULL, payload TEXT NOT NULL
      );`);
  try {
    db.transaction(() => {
      for (const row of db.query<WatchRow, []>("SELECT * FROM watches").all()) {
        const decoded = decodeStoredSpec(JSON.parse(row.spec));
        if (decoded.schemaVersion === "current") {
          db.query("UPDATE watches SET spec=?, dedupe_key=? WHERE id=?").run(
            JSON.stringify(decoded.spec),
            watchDedupeKey(decoded.spec),
            row.id,
          );
        }
        if (decoded.schemaVersion === "legacy" && row.status === "active") {
          db.query(
            "UPDATE watches SET status='cancelled', last_error='reauthorization_required' WHERE id=?",
          ).run(row.id);
        }
      }
    }).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
