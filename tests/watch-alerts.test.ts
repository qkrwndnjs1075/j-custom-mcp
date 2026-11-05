import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WatchStore } from "../src/watch-store";
import { type Observation, WatchError, WatchSpecSchema } from "../src/watch-types";

const start = Date.UTC(2030, 0, 1);
const spec = WatchSpecSchema.parse({
  criteria: {
    service: "intercity",
    departureId: "0000001",
    arrivalId: "0000002",
    date: "2030-01-02",
    time: "00:00",
    endTime: "23:59",
    minSeats: 1,
    passengers: { adults: 1, students: 0, children: 0 },
    ranking: ["departure_time"],
  },
  mode: "seats_available",
  intervalSeconds: 600,
  notification: "on_transition",
  retryPolicy: { mode: "exponential_backoff", maxIntervalSeconds: 86400 },
  expiresAt: "2030-01-02T14:59:59.999Z",
});
const matched: Observation = {
  kind: "matched",
  matches: [
    {
      service: "intercity",
      tripKey: "route:service:1",
      departureDate: "20300102",
      departureTime: "120000",
      departureName: "Departure",
      arrivalName: "Arrival",
      adultFareKrw: 12000,
      totalFareKrw: 12000,
      passengers: { adults: 1, students: 0, children: 0 },
      fareQuotes: {
        adults: { unitFareKrw: 12000, fareKindCode: null },
        students: null,
        children: null,
      },
      remainingSeats: 2,
    },
  ],
};
const stores: WatchStore[] = [];
const directories: string[] = [];
function open(path = ":memory:", now: () => number = () => start): WatchStore {
  const store = new WatchStore(path, now);
  stores.push(store);
  return store;
}
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "tmoney-watch-"));
  directories.push(directory);
  return join(directory, "watch.sqlite");
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("availability transitions and inbox", () => {
  test("emits once for an initial match and remains quiet while matched", () => {
    const store = open();
    const watch = store.create(spec).watch;
    store.record(watch.id, matched);
    expect(store.record(watch.id, matched)).toBe(false);
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(1);
  });

  test("emits again after a confirmed non-match then match", () => {
    const store = open();
    const watch = store.create(spec).watch;
    store.record(watch.id, matched);
    store.record(watch.id, { kind: "not_matched" });
    expect(store.record(watch.id, matched)).toBe(true);
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(2);
  });

  test("unknown observations neither alert nor reset the matched baseline", () => {
    const store = open();
    const watch = store.create(spec).watch;
    store.record(watch.id, matched);
    store.record(watch.id, { kind: "unknown", reason: "provider_timeout" });
    expect(store.record(watch.id, matched)).toBe(false);
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(1);
  });

  test("does not infer booking availability from an unknown observation", () => {
    const store = open();
    const watch = store.create({ ...spec, mode: "booking_available" }).watch;
    expect(store.record(watch.id, { kind: "unknown", reason: "provider_network" })).toBe(false);
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(0);
    expect(store.list()[0]?.lastOutcome).toBe("unknown");
  });

  test("keeps inconclusive pre-opening checks at normal cadence after a technical failure", () => {
    let now = start;
    const store = open(":memory:", () => now);
    const watch = store.create({ ...spec, mode: "booking_available" }).watch;
    store.record(watch.id, { kind: "unknown", reason: "provider_network" });
    now += 1200_000;
    for (let cycle = 0; cycle < 12; cycle++) {
      expect(store.due().map((entry) => entry.id)).toEqual([watch.id]);
      store.record(watch.id, { kind: "inconclusive", reason: "unknown_empty" });
      expect(store.list()[0]).toMatchObject({
        lastOutcome: "inconclusive",
        consecutiveFailures: 0,
        lastError: "unknown_empty",
        nextCheckAt: new Date(now + 600_000).toISOString(),
      });
      now += 600_000;
    }
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(0);
    expect(store.record(watch.id, matched)).toBe(true);
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(1);
  });

  test("inconclusive observations preserve the matched baseline without false reopening", () => {
    const store = open();
    const watch = store.create(spec).watch;
    store.record(watch.id, matched);
    store.record(watch.id, { kind: "inconclusive", reason: "unknown_availability" });
    expect(store.record(watch.id, matched)).toBe(false);
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(1);
  });

  test("persists exponential failure backoff and resets it after a known observation", () => {
    let now = start;
    const store = open(":memory:", () => now);
    const watch = store.create(spec).watch;
    store.record(watch.id, { kind: "unknown", reason: "timeout" });
    expect(store.list()[0]).toMatchObject({
      consecutiveFailures: 1,
      nextCheckAt: new Date(start + 1200_000).toISOString(),
    });
    now += 1200_000;
    store.record(watch.id, { kind: "unknown", reason: "timeout" });
    expect(store.list()[0]).toMatchObject({
      consecutiveFailures: 2,
      nextCheckAt: new Date(now + 2400_000).toISOString(),
    });
    now += 2400_000;
    store.record(watch.id, { kind: "not_matched" });
    expect(store.list()[0]).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
      nextCheckAt: new Date(now + 600_000).toISOString(),
    });
  });

  test("keeps monotonically increasing alert cursors after database restart", () => {
    const path = databasePath();
    const first = open(path);
    const watch = first.create(spec).watch;
    first.record(watch.id, matched);
    const cursor = first.getAlerts({ after: 0, limit: 50 }).nextCursor;
    first.close();
    const reopened = open(path);
    reopened.record(watch.id, { kind: "not_matched" });
    reopened.record(watch.id, matched);
    const page = reopened.getAlerts({ after: cursor, limit: 50 });
    expect(page.alerts).toHaveLength(1);
    expect(page.nextCursor).toBeGreaterThan(cursor);
    expect(page.gap).toBe(false);
  });

  test("exposes retained-history gaps and paginates from a persistent cursor", () => {
    const store = open();
    const watch = store.create(spec).watch;
    for (let index = 0; index < 1001; index++) {
      store.record(watch.id, { kind: "not_matched" });
      store.record(watch.id, matched);
    }
    const page = store.getAlerts({ after: 0, limit: 2 });
    expect(page).toMatchObject({
      oldestCursor: 2,
      latestCursor: 1001,
      nextCursor: 3,
      hasMore: true,
      gap: true,
    });
    expect(page.alerts.map((alert) => alert.cursor)).toEqual([2, 3]);
    expect(store.getAlerts({ after: page.nextCursor, limit: 1 }).alerts[0]?.cursor).toBe(4);
    expect(store.getAlerts({ after: 1001, limit: 50 })).toMatchObject({
      alerts: [],
      nextCursor: 1001,
      hasMore: false,
    });
  });

  test("rejects empty matched observations without changing state", () => {
    const store = open();
    const watch = store.create(spec).watch;
    expect(() => store.record(watch.id, { kind: "matched", matches: [] })).toThrow(WatchError);
    expect(store.list()[0]?.lastOutcome).toBeNull();
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(0);
  });
});

test("every_match emits on each match and preserves selected passenger fare totals", () => {
  const store = open();
  const watch = store.create({ ...spec, notification: "every_match" }).watch;
  store.record(watch.id, matched);
  expect(store.record(watch.id, matched)).toBe(true);
  expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(2);
  expect(store.getAlerts({ after: 0, limit: 50 }).alerts[0]?.matches[0]).toMatchObject({
    passengers: { adults: 1, students: 0, children: 0 },
    totalFareKrw: 12000,
  });
});

test("fixed_interval preserves caller cadence through repeated failures", () => {
  const store = open();
  const watch = store.create({ ...spec, retryPolicy: { mode: "fixed_interval" } }).watch;
  store.record(watch.id, { kind: "unknown", reason: "offline" });
  store.record(watch.id, { kind: "unknown", reason: "offline" });
  expect(store.list()[0]).toMatchObject({
    consecutiveFailures: 2,
    nextCheckAt: new Date(start + 600_000).toISOString(),
  });
});

test("exponential_backoff stops at caller maximum", () => {
  const store = open();
  const watch = store.create({
    ...spec,
    retryPolicy: { mode: "exponential_backoff", maxIntervalSeconds: 900 },
  }).watch;
  store.record(watch.id, { kind: "unknown", reason: "offline" });
  store.record(watch.id, { kind: "unknown", reason: "offline" });
  expect(store.list()[0]?.nextCheckAt).toBe(new Date(start + 900_000).toISOString());
});
