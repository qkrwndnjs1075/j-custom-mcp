import { createHash } from "node:crypto";
import { openLocalDatabase } from "#local-runtime";
import { BookingError } from "./booking-types";
import type { SyncDatabase } from "./sql-database";

export function openBookingDatabase(path: string | SyncDatabase, accountId: string): SyncDatabase {
  if (typeof accountId !== "string" || !accountId.trim() || accountId.length > 256)
    throw new BookingError("configuration");
  const hash = createHash("sha256").update(accountId).digest("hex");
  const db = typeof path === "string" ? openLocalDatabase(path, "booking") : path;
  try {
    db.run(`CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, stage TEXT NOT NULL,
        revision INTEGER NOT NULL, next_check_at INTEGER NOT NULL, record TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS booking_owner (slot INTEGER PRIMARY KEY CHECK(slot=1), account_hash TEXT NOT NULL);`);
    db.transaction(() => {
      const owner = db
        .query<{ readonly account_hash: string }, []>(
          "SELECT account_hash FROM booking_owner WHERE slot=1",
        )
        .get();
      if (owner) {
        if (owner.account_hash !== hash) throw new BookingError("configuration");
      } else {
        const count =
          db.query<{ readonly count: number }, []>("SELECT COUNT(*) AS count FROM bookings").get()
            ?.count ?? 0;
        if (count > 0) throw new BookingError("configuration");
        db.query("INSERT INTO booking_owner VALUES (1,?)").run(hash);
      }
    }).immediate();
    return db;
  } catch (error) {
    db.close();
    if (error instanceof BookingError) throw error;
    throw new BookingError("configuration");
  }
}
