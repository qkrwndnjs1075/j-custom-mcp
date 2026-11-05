import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookingStore } from "../src/booking-store";
import { WatchStore } from "../src/watch-store";

export const now = Date.UTC(2030, 0, 1);
// Literal pre-service records deliberately do not use current schema builders.
export const oldCriteria = {
  departureId: "0000001",
  arrivalId: "0000002",
  date: "2030-01-02",
  time: "00:00",
  endTime: "23:59",
  passengers: { adults: 1, students: 0, children: 0 },
  ranking: ["departure_time"],
  maxFareKrw: 20000,
  minSeats: 1,
};
export const oldSpec = {
  version: 2,
  idempotencyKey: "7afac127-e909-48dd-89d1-e0a3cfe30646",
  criteria: oldCriteria,
  expiresAt: "2030-01-02T14:59:59.999Z",
  intervalSeconds: 600,
  seatPolicy: { mode: "first_available", order: "descending", passengerOrder: ["adult"] },
  payment: { method: "naver_pay_auto" },
  discounts: { mode: "none" },
};
export const oldTrip = {
  routeId: "00123",
  routeSequence: "01",
  serviceDate: "20300102",
  serviceSequence: "0007",
  departureId: "0000001",
  arrivalId: "0000002",
  departureName: "A",
  arrivalName: "B",
  scheduledDepartureTime: "120000",
  carrierId: "03",
  busClassId: "1",
  carrierName: "Synthetic",
  busClassName: "Synthetic",
  adultCount: 1,
  studentCount: 0,
  childCount: 0,
  remainingSeats: 3,
  totalSeats: 4,
  departureDate: "20300102",
  departureTime: "120000",
  discountAvailable: "N",
  adultFareKrw: 15000,
  estimatedDurationMinutes: null,
  passengers: { adults: 1, students: 0, children: 0 },
  fareQuotes: {
    adults: { unitFareKrw: 15000, fareKindCode: null },
    students: null,
    children: null,
  },
  totalFareKrw: 15000,
  tripKey: "00123:01:20300102:0007:0000001:0000002",
  availability: "available",
};
export const oldRecord = {
  id: "b6f83e90-1972-4b8d-bbf0-e76af4fc1950",
  spec: oldSpec,
  exactTrip: oldTrip,
  stage: "watching",
  bindingHash: "a".repeat(64),
  revision: 4,
  createdAt: now,
  updatedAt: now,
  nextCheckAt: now,
  checkCount: 2,
  lastError: null,
  hold: null,
  selection: null,
  purchaseMonth: null,
  paymentOrderNumber: null,
  issueAttempted: false,
  releaseAccepted: null,
};
export const oldWatch = {
  criteria: oldCriteria,
  mode: "seats_available",
  intervalSeconds: 600,
  notification: "on_transition",
  retryPolicy: { mode: "exponential_backoff" as const, maxIntervalSeconds: 3600 },
  expiresAt: "2030-01-02T14:59:59.999Z",
};
export const oldMatch = {
  tripKey: oldTrip.tripKey,
  departureDate: "20300102",
  departureTime: "120000",
  departureName: "A",
  arrivalName: "B",
  passengers: oldCriteria.passengers,
  fareQuotes: oldTrip.fareQuotes,
  totalFareKrw: 15000,
  adultFareKrw: 15000,
  remainingSeats: 3,
};
export const oldAlert = {
  mode: "seats_available",
  criteria: oldCriteria,
  matches: [oldMatch],
  matchCount: 1,
};
export function historyHarness() {
  const directories: string[] = [];
  const stores: { close(): void }[] = [];
  function cleanup() {
    for (const store of stores.splice(0)) store.close();
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  }
  function databasePath() {
    const directory = mkdtempSync(join(tmpdir(), "service-history-"));
    directories.push(directory);
    return join(directory, "records.sqlite");
  }
  function historicalBooking() {
    const path = databasePath();
    new BookingStore(path, "synthetic-owner", () => now).close();
    const db = new Database(path);
    db.query("INSERT INTO bookings VALUES (?,?,?,?,?,?)").run(
      oldRecord.id,
      oldSpec.idempotencyKey,
      "watching",
      4,
      now,
      JSON.stringify(oldRecord),
    );
    db.close();
    const store = new BookingStore(path, "synthetic-owner", () => now);
    stores.push(store);
    return store;
  }
  function historicalWatch() {
    const path = databasePath();
    new WatchStore(path, () => now).close();
    const db = new Database(path);
    db.query(`INSERT INTO watches
    (id,dedupe_key,spec,status,created_at,expires_at,next_check_at,matched,last_outcome)
    VALUES (?,?,?,'active',?,?,?,1,'matched')`).run(
      "old-watch",
      "old-key",
      JSON.stringify(oldWatch),
      now,
      Date.parse(oldWatch.expiresAt),
      now,
    );
    db.query("INSERT INTO alerts(watch_id,generated_at,payload) VALUES (?,?,?)").run(
      "old-watch",
      now,
      JSON.stringify(oldAlert),
    );
    db.close();
    return path;
  }

  return { cleanup, stores, databasePath, historicalBooking, historicalWatch };
}
