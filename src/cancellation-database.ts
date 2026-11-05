import type { z } from "zod";
import { openBookingDatabase } from "./booking-database";
import { CancellationError } from "./cancellation-types";
import type { SyncDatabase } from "./sql-database";

export function openCancellationDatabase(
  path: string | SyncDatabase,
  accountId: string,
): SyncDatabase {
  let db: SyncDatabase | undefined;
  try {
    db = openBookingDatabase(path, accountId);
    db.run(`CREATE TABLE IF NOT EXISTS cancellation_quotes (
      id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, record TEXT NOT NULL
    ); CREATE TABLE IF NOT EXISTS cancellations (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, stage TEXT NOT NULL,
      revision INTEGER NOT NULL, record TEXT NOT NULL
    );`);
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof CancellationError) throw error;
    throw new CancellationError("configuration");
  }
}
export function decodeCancellation<T>(row: { readonly record: string }, schema: z.ZodType<T>): T {
  try {
    const value: unknown = JSON.parse(row.record);
    const result = schema.safeParse(value);
    if (!result.success) throw new CancellationError("configuration");
    return result.data;
  } catch (error) {
    if (error instanceof CancellationError) throw error;
    throw new CancellationError("configuration");
  }
}
