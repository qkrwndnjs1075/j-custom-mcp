import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceLimitsSchema } from "../src/service-limits";
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

describe("durable watches", () => {
  test("keeps different cadence and expiry choices independent", () => {
    const store = open();
    const first = store.create(spec);
    const repeated = store.create({
      ...spec,
      intervalSeconds: 300,
      expiresAt: "2030-01-02T14:00:00.000Z",
    });
    expect(first.created).toBe(true);
    expect(repeated.created).toBe(true);
    expect(repeated.watch.id).not.toBe(first.watch.id);
    expect(repeated.watch.intervalSeconds).toBe(300);
    expect(store.list()).toHaveLength(2);
    expect(store.create(spec)).toEqual({ watch: first.watch, created: false });
  });

  test("rejects a twenty-first active watch", () => {
    const store = open();
    for (let hour = 0; hour < 20; hour++) {
      store.create({
        ...spec,
        criteria: { ...spec.criteria, time: `${String(hour).padStart(2, "0")}:00` },
      });
    }
    expect(() => store.create({ ...spec, mode: "booking_available" })).toThrow(WatchError);
    expect(store.due()).toHaveLength(20);
  });

  test("keeps active watches while bounding retained cancelled watches", () => {
    const store = open();
    const active = store.create(spec).watch;
    for (let index = 0; index < 100; index++) {
      store.cancel(store.create({ ...spec, mode: "booking_available" }).watch.id);
    }
    const watches = store.list();
    expect(watches.filter((watch) => watch.status === "cancelled")).toHaveLength(80);
    expect(watches.find((watch) => watch.id === active.id)?.status).toBe("active");
  });

  test("does not poll or emit for cancelled watches", () => {
    const store = open();
    const watch = store.create(spec).watch;
    store.cancel(watch.id);
    expect(store.record(watch.id, matched)).toBe(false);
    expect(store.due()).toHaveLength(0);
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(0);
  });

  test("expires watches exactly at the configured boundary", () => {
    let now = start;
    const store = open(":memory:", () => now);
    const watch = store.create(spec).watch;
    now = Date.parse(spec.expiresAt);
    expect(store.due()).toHaveLength(0);
    expect(store.list()[0]?.status).toBe("expired");
    expect(store.record(watch.id, matched)).toBe(false);
    expect(() => store.create(spec)).toThrow(WatchError);
  });

  test("restores matched baseline, failure status, due time, and inbox after restart", () => {
    const path = databasePath();
    const first = open(path);
    const watch = first.create(spec).watch;
    first.record(watch.id, matched);
    first.record(watch.id, { kind: "unknown", reason: "provider unavailable" });
    const before = first.list();
    first.close();
    const reopened = open(path);
    expect(reopened.list()).toEqual(before);
    expect(reopened.getAlerts({ after: 0, limit: 50 }).alerts[0]?.delivery).toBe("inbox_only");
    expect(reopened.record(watch.id, matched)).toBe(false);
    expect(reopened.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(1);
  });

  test("rolls back alert insertion when the matching state update fails", () => {
    const path = databasePath();
    const store = open(path);
    const watch = store.create(spec).watch;
    const fault = new Database(path);
    fault.run(`CREATE TRIGGER fail_state BEFORE UPDATE OF matched ON watches
      BEGIN SELECT RAISE(ABORT, 'injected state update failure'); END;`);
    fault.close();
    expect(() => store.record(watch.id, matched)).toThrow("injected state update failure");
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(0);
    expect(store.list()[0]?.lastOutcome).toBeNull();
  });
});

test("different notification and retry choices remain independent", () => {
  const store = open();
  const first = store.create(spec).watch;
  const repeated = store.create({ ...spec, notification: "every_match" });
  const fixed = store.create({ ...spec, retryPolicy: { mode: "fixed_interval" } });
  expect(repeated.created).toBe(true);
  expect(fixed.created).toBe(true);
  expect(new Set([first.id, repeated.watch.id, fixed.watch.id]).size).toBe(3);
});

test("configured watch limits bound cadence, capacity, history, and alert pages", () => {
  const limits = ServiceLimitsSchema.parse({
    minimumPollSeconds: 10,
    maximumPollSeconds: 120,
    activeWatches: 1,
    retainedWatches: 1,
    retainedAlerts: 1,
    alertMatches: 1,
    alertPageSize: 1,
  });
  const store = new WatchStore(":memory:", () => start, limits);
  stores.push(store);
  const selected = {
    ...spec,
    intervalSeconds: 10,
    notification: "every_match" as const,
    retryPolicy: { mode: "fixed_interval" as const },
  };
  expect(() => store.create({ ...selected, intervalSeconds: 9 })).toThrow(WatchError);
  expect(() => store.create({ ...selected, intervalSeconds: 121 })).toThrow(WatchError);
  expect(() =>
    store.create({
      ...selected,
      retryPolicy: { mode: "exponential_backoff", maxIntervalSeconds: 121 },
    }),
  ).toThrow(WatchError);
  const first = store.create(selected).watch;
  expect(() => store.create({ ...selected, notification: "on_transition" })).toThrow(WatchError);
  store.record(first.id, matched);
  store.record(first.id, matched);
  expect(store.getAlerts({ after: 0, limit: 1 })).toMatchObject({
    gap: true,
    oldestCursor: 2,
    latestCursor: 2,
  });
  expect(() => store.getAlerts({ after: 0, limit: 2 })).toThrow(WatchError);
  store.cancel(first.id);
  const next = store.create(selected).watch;
  store.cancel(next.id);
  expect(store.list().map((watch) => watch.id)).toEqual([next.id]);
});
