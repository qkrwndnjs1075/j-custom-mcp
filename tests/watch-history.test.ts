import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchRunner } from "../src/watch-runner";
import { WatchStore } from "../src/watch-store";

const start = Date.UTC(2030, 0, 1);
const legacySpec = {
  criteria: {
    departureId: "0000001",
    arrivalId: "0000002",
    date: "2030-01-02",
    time: "00:00",
    endTime: "23:59",
    minSeats: 1,
  },
  mode: "seats_available",
  intervalSeconds: 600,
  expiresAt: "2030-01-02T14:59:59.999Z",
};
const legacyAlert = {
  mode: "seats_available",
  criteria: legacySpec.criteria,
  matchCount: 1,
  matches: [
    {
      tripKey: "old-trip",
      departureDate: "20300102",
      departureTime: "120000",
      departureName: "A",
      arrivalName: "B",
      adultFareKrw: 12000,
      remainingSeats: 2,
    },
  ],
};
const directories: string[] = [];
const stores: WatchStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function legacyDatabase(spec: unknown = legacySpec): string {
  const directory = mkdtempSync(join(tmpdir(), "watch-legacy-"));
  directories.push(directory);
  const path = join(directory, "watch.sqlite");
  const db = new Database(path);
  db.run(`CREATE TABLE watches (
    id TEXT PRIMARY KEY, dedupe_key TEXT NOT NULL, spec TEXT NOT NULL,
    status TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    next_check_at INTEGER NOT NULL, matched INTEGER NOT NULL DEFAULT 0,
    last_outcome TEXT, last_checked_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, last_error TEXT
  ); CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id TEXT NOT NULL, generated_at INTEGER NOT NULL, payload TEXT NOT NULL);`);
  db.query(
    "INSERT INTO watches(id,dedupe_key,spec,status,created_at,expires_at,next_check_at) VALUES (?,?,?,'active',?,?,?)",
  ).run(
    "legacy-id",
    "legacy-key",
    JSON.stringify(spec),
    start,
    Date.parse(legacySpec.expiresAt),
    start,
  );
  db.query("INSERT INTO alerts(watch_id,generated_at,payload) VALUES (?,?,?)").run(
    "legacy-id",
    start,
    JSON.stringify(legacyAlert),
  );
  db.close();
  return path;
}
test("legacy active watch requires reauthorization and never evaluates after reopening", async () => {
  const path = legacyDatabase();
  const store = new WatchStore(path, () => start);
  stores.push(store);
  let evaluations = 0;
  const runner = new WatchRunner({
    store,
    evaluate: async () => {
      evaluations++;
      return { kind: "not_matched" };
    },
  });
  expect(await runner.tick()).toEqual({ checked: 0, skippedOverlap: false });
  expect(evaluations).toBe(0);
  expect(store.list()[0]).toMatchObject({
    ...legacySpec,
    schemaVersion: "legacy",
    status: "cancelled",
    lastError: "reauthorization_required",
  });
  const db = new Database(path);
  expect(db.query<{ spec: string }, []>("SELECT spec FROM watches").get()?.spec).toBe(
    JSON.stringify(legacySpec),
  );
  db.close();
  const alerts = store.getAlerts({ after: 0, limit: 50 }).alerts;
  expect(alerts[0]).toMatchObject({
    ...legacyAlert,
    schemaVersion: "legacy",
    cursor: 1,
    delivery: "inbox_only",
  });
  expect(alerts[0]?.criteria).not.toHaveProperty("passengers");
  expect(alerts[0]?.matches[0]).not.toHaveProperty("totalFareKrw");
});
test("legacy omitted cadence remains omitted and cannot execute", () => {
  const { intervalSeconds: _interval, ...implicitSpec } = legacySpec;
  const store = new WatchStore(legacyDatabase(implicitSpec), () => start);
  stores.push(store);
  expect(store.list()[0]).not.toHaveProperty("intervalSeconds");
  expect(store.due()).toEqual([]);
});
test.each([
  { ...legacySpec, notification: "every_match" },
  { ...legacySpec, retryPolicy: { mode: "fixed_interval" } },
  {
    ...legacySpec,
    criteria: { ...legacySpec.criteria, passengers: { adults: 1, students: 0, children: 0 } },
  },
  { ...legacySpec, criteria: { ...legacySpec.criteria, ranking: ["fare"] } },
])("malformed partial modern watch fails closed without legacy downgrade", (spec) => {
  const path = legacyDatabase(spec);
  expect(() => new WatchStore(path, () => start)).toThrow();
  const db = new Database(path);
  expect(db.query<{ status: string }, []>("SELECT status FROM watches").get()?.status).toBe(
    "active",
  );
  db.close();
});
