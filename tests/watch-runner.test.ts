import { afterEach, describe, expect, test } from "bun:test";
import { WatchRunner } from "../src/watch-runner";
import { WatchStore } from "../src/watch-store";
import { type Observation, WatchSpecSchema } from "../src/watch-types";

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
const stores: WatchStore[] = [];
function open(now: () => number = () => start): WatchStore {
  const store = new WatchStore(":memory:", now);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

describe("bounded watch polling", () => {
  test("coalesces identical criteria and mode across notification policies", async () => {
    const store = open();
    store.create(spec);
    store.create({ ...spec, notification: "every_match" });
    let calls = 0;
    const runner = new WatchRunner({
      store,
      evaluate: async () => {
        calls++;
        return { kind: "not_matched" };
      },
    });
    expect(await runner.tick()).toEqual({ checked: 2, skippedOverlap: false });
    expect(calls).toBe(1);
    expect(store.list().map((watch) => watch.lastOutcome)).toEqual(["not_matched", "not_matched"]);
  });

  test("skips an overlapping tick without launching a second query", async () => {
    const store = open();
    store.create(spec);
    const evaluation = Promise.withResolvers<Observation>();
    let calls = 0;
    const runner = new WatchRunner({
      store,
      evaluate: () => {
        calls++;
        return evaluation.promise;
      },
    });
    const first = runner.tick();
    const overlap = await runner.tick();
    evaluation.resolve({ kind: "not_matched" });
    await first;
    expect(overlap).toEqual({ checked: 0, skippedOverlap: true });
    expect(calls).toBe(1);
  });

  test("runs distinct provider queries sequentially", async () => {
    const store = open();
    store.create(spec);
    store.create({ ...spec, criteria: { ...spec.criteria, time: "12:00" } });
    const firstQuery = Promise.withResolvers<Observation>();
    const requested: string[] = [];
    const runner = new WatchRunner({
      store,
      evaluate: async (criteria) => {
        requested.push(criteria.time);
        return requested.length === 1 ? firstQuery.promise : { kind: "not_matched" };
      },
    });
    const tick = runner.tick();
    expect(requested).toEqual(["00:00"]);
    firstQuery.resolve({ kind: "not_matched" });
    await tick;
    expect(requested).toEqual(["00:00", "12:00"]);
  });

  test("waits for an external tick even after an overlapping call returns", async () => {
    const store = open();
    store.create(spec);
    const evaluation = Promise.withResolvers<Observation>();
    const runner = new WatchRunner({ store, evaluate: () => evaluation.promise });
    const active = runner.tick();
    let idle = false;
    const waiting = runner.whenIdle().then(() => {
      idle = true;
    });
    await runner.tick();
    expect(idle).toBe(false);
    evaluation.resolve({ kind: "not_matched" });
    await Promise.all([active, waiting]);
    expect(idle).toBe(true);
    await runner.whenIdle();
  });

  test("persists a failed callback and waits for its backoff deadline", async () => {
    let now = start;
    const store = open(() => now);
    store.create(spec);
    let calls = 0;
    const runner = new WatchRunner({
      store,
      evaluate: async () => {
        calls++;
        throw new TypeError("connection failed");
      },
    });
    await runner.tick();
    now = start + 1200_000 - 1;
    expect(await runner.tick()).toEqual({ checked: 0, skippedOverlap: false });
    expect(calls).toBe(1);
    expect(store.list()[0]).toMatchObject({
      lastOutcome: "unknown",
      lastError: "connection failed",
      consecutiveFailures: 1,
    });
    now++;
    expect(await runner.tick()).toEqual({ checked: 1, skippedOverlap: false });
    expect(calls).toBe(2);
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(0);
  });

  test("does not write an alert when cancelled during provider evaluation", async () => {
    const store = open();
    const watch = store.create(spec).watch;
    const evaluation = Promise.withResolvers<Observation>();
    const runner = new WatchRunner({ store, evaluate: () => evaluation.promise });
    const tick = runner.tick();
    store.cancel(watch.id);
    evaluation.resolve({
      kind: "matched",
      matches: [
        {
          service: "intercity",
          tripKey: "stable-route-service",
          departureDate: "20300102",
          departureTime: "120000",
          departureName: "Departure",
          arrivalName: "Arrival",
          adultFareKrw: 10000,
          totalFareKrw: 10000,
          passengers: { adults: 1, students: 0, children: 0 },
          fareQuotes: {
            adults: { unitFareKrw: 10000, fareKindCode: null },
            students: null,
            children: null,
          },
          remainingSeats: 1,
        },
      ],
    });
    await tick;
    expect(store.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(0);
    expect(store.list()[0]?.status).toBe("cancelled");
  });

  test("continues evaluating other criteria after one provider failure", async () => {
    const store = open();
    store.create(spec);
    store.create({ ...spec, criteria: { ...spec.criteria, time: "12:00" } });
    const runner = new WatchRunner({
      store,
      evaluate: async (criteria) => {
        if (criteria.time === "00:00") throw new TypeError("network failed");
        return { kind: "not_matched" };
      },
    });
    await runner.tick();
    expect(
      store
        .list()
        .map((watch) => watch.lastOutcome)
        .sort(),
    ).toEqual(["not_matched", "unknown"]);
  });
});
