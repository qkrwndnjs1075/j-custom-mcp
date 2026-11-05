import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { decodeStoredAlert, decodeStoredSpec } from "../src/watch-history";
import { WatchStore } from "../src/watch-store";
import { WatchMatchSchema, WatchSpecSchema } from "../src/watch-types";
import {
  historyHarness,
  now,
  oldAlert,
  oldCriteria,
  oldMatch,
  oldWatch,
} from "./service-history-fixtures";

const { cleanup, stores, databasePath, historicalWatch } = historyHarness();
afterEach(cleanup);

test("retains historical modern watch authority and ID across repeated reopen and create", () => {
  // Given
  const path = historicalWatch();
  new WatchStore(path, () => now).close();
  const store = new WatchStore(path, () => now);
  stores.push(store);
  const spec = WatchSpecSchema.parse({
    ...oldWatch,
    criteria: { ...oldCriteria, service: "intercity" },
  });
  // When
  const repeated = store.create(spec);
  // Then
  expect(repeated.created).toBe(false);
  expect(repeated.watch.id).toBe("old-watch");
  expect(repeated.watch.status).toBe("active");
  expect(repeated.watch.retryPolicy).toEqual(oldWatch.retryPolicy);
  expect(store.due()).toHaveLength(1);
  expect(store.due()[0]?.criteria.service).toBe("intercity");
  expect(store.list()).toHaveLength(1);
});

test("does not duplicate a pre-service matched alert after service key normalization", () => {
  // Given
  const store = new WatchStore(historicalWatch(), () => now);
  stores.push(store);
  const match = WatchMatchSchema.parse({
    ...oldMatch,
    service: "intercity",
    tripKey: `intercity:${oldMatch.tripKey}`,
  });
  // When
  const emitted = store.record("old-watch", { kind: "matched", matches: [match] });
  // Then
  expect(emitted).toBe(false);
  const alerts = store.getAlerts({ after: 0, limit: 10 }).alerts;
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({
    cursor: 1,
    watchId: "old-watch",
    schemaVersion: "current",
    criteria: { service: "intercity" },
    matches: [{ service: "intercity", tripKey: `intercity:${oldMatch.tripKey}` }],
  });
});

test.each(["unknown", null, "express"])(
  "rejects invalid modern watch service %j without downgrade",
  (service) => {
    // Given / When / Then
    expect(() =>
      decodeStoredSpec({ ...oldWatch, criteria: { ...oldCriteria, service } }),
    ).toThrow();
    expect(() =>
      decodeStoredAlert({ ...oldAlert, criteria: { ...oldCriteria, service } }),
    ).toThrow();
  },
);

test("retains express identity and quoted totals when adult fare is unknown in inbox", () => {
  // Given
  const store = new WatchStore(databasePath(), () => now);
  stores.push(store);
  const spec = WatchSpecSchema.parse({
    ...oldWatch,
    criteria: { ...oldCriteria, service: "express", departureId: "021", arrivalId: "393" },
  });
  const watch = store.create(spec).watch;
  const match = WatchMatchSchema.parse({
    ...oldMatch,
    service: "express",
    adultFareKrw: null,
    tripKey: "express:021:393:20300102:120000",
  });
  // When
  store.record(watch.id, { kind: "matched", matches: [match] });
  // Then
  expect(store.getAlerts({ after: 0, limit: 10 }).alerts[0]).toMatchObject({
    criteria: { service: "express" },
    matches: [{ service: "express", adultFareKrw: null, totalFareKrw: 15000 }],
  });
});

test("rolls back watch normalization when another stored record is malformed", () => {
  // Given
  const path = historicalWatch();
  const db = new Database(path);
  db.query(`INSERT INTO watches
    (id,dedupe_key,spec,status,created_at,expires_at,next_check_at)
    VALUES (?,?,?,'active',?,?,?)`).run(
    "invalid-watch",
    "invalid-key",
    JSON.stringify({
      ...oldWatch,
      criteria: { ...oldCriteria, service: "invalid" },
    }),
    now,
    Date.parse(oldWatch.expiresAt),
    now,
  );
  // When / Then
  expect(() => new WatchStore(path, () => now)).toThrow();
  expect(
    db
      .query<{ spec: string; dedupe_key: string }, []>(
        "SELECT spec,dedupe_key FROM watches WHERE id='old-watch'",
      )
      .get(),
  ).toEqual({ spec: JSON.stringify(oldWatch), dedupe_key: "old-key" });
  db.close();
});
