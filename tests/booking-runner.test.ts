import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BookingRunner } from "../src/booking-runner";
import { GoBusError } from "../src/go-bus-types";
import { GoPurchaseError } from "../src/go-purchase";
import { TripQueryService } from "../src/query";
import { harness, specification, webTrip } from "./booking-fixtures";

const active: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const item of active.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});
function setup() {
  const item = harness();
  active.push(item);
  return item;
}

test("persists each mutation stage and only books after independent reconciliation", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create(specification());
  // When
  await item.runner.tick();
  // Then
  expect(
    item.actions.filter(({ action }) => ["hold", "reserve", "issue", "reconcile"].includes(action)),
  ).toEqual([
    { action: "hold", stage: "holding" },
    { action: "reserve", stage: "reserving" },
    { action: "issue", stage: "issuing" },
    { action: "reconcile", stage: "reconciling" },
  ]);
  const booking = item.store.get(created.booking.id);
  expect(booking?.stage).toBe("booked");
  expect(booking?.selection?.seat).toBe(1);
  expect(item.store.read(created.booking.id)?.purchaseMonth).toBe("202610");
  expect(JSON.stringify(booking)).not.toMatch(
    /synthetic-(?:payment-order|hold|ticket|order)-private/,
  );
});

test("chooses the explicitly authorized seat", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create({
    ...specification(),
    seatPolicy: { mode: "only", seats: [{ seat: 3, passengerType: "adult" }] },
  });
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)?.selection?.seat).toBe(3);
});

test("blocks overlapping ticks and cancellation during a hold", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create(specification());
  const entered = Promise.withResolvers<void>();
  const leave = Promise.withResolvers<void>();
  item.hooks.hold = async () => {
    entered.resolve();
    await leave.promise;
  };
  const first = item.runner.tick();
  await entered.promise;
  // When
  const second = await item.runner.tick();
  const cancelled = item.store.cancel(created.booking.id);
  leave.resolve();
  await first;
  // Then
  expect(second.skippedOverlap).toBe(true);
  expect(cancelled.cancelled).toBe(false);
  expect(item.actions.filter(({ action }) => action === "hold")).toHaveLength(1);
});

test("two runners racing the same due booking issue at most one hold", async () => {
  // Given
  const item = setup();
  await item.runner.create(specification());
  const second = new BookingRunner(item.options);
  const entered = Promise.withResolvers<void>();
  const leave = Promise.withResolvers<void>();
  let scans = 0;
  item.hooks.scan = async () => {
    scans++;
    if (scans === 2) entered.resolve();
    await leave.promise;
  };
  const firstRun = item.runner.tick();
  const secondRun = second.tick();
  await entered.promise;
  // When
  leave.resolve();
  await Promise.all([firstRun, secondRun]);
  // Then
  expect(item.actions.filter(({ action }) => action === "hold")).toHaveLength(1);
  expect(item.actions.filter(({ action }) => action === "reserve")).toHaveLength(1);
});

test("never repeats a hold whose outcome is unknown", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create(specification());
  item.hooks.hold = () => {
    throw new GoBusError("hold_uncertain");
  };
  await item.runner.tick();
  item.state.now += 600000;
  // When
  await new BookingRunner(item.options).tick();
  // Then
  expect(item.store.get(created.booking.id)?.stage).toBe("uncertain");
  expect(item.actions.filter(({ action }) => action === "hold")).toHaveLength(1);
  expect(item.actions.some(({ action }) => action === "reserve")).toBe(false);
});

test("reconciles an uncertain issue without issuing again after restart", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create(specification());
  item.hooks.issue = () => {
    throw new GoPurchaseError("purchase_uncertain");
  };
  item.hooks.reconcile = () => {
    throw new GoPurchaseError("network");
  };
  await item.runner.tick();
  item.state.now += 600000;
  delete item.hooks.reconcile;
  // When
  await new BookingRunner(item.options).tick();
  // Then
  expect(item.store.get(created.booking.id)?.stage).toBe("booked");
  expect(item.actions.filter(({ action }) => action === "issue")).toHaveLength(1);
  expect(item.actions.filter(({ action }) => action === "reserve")).toHaveLength(1);
  expect(item.actions.filter(({ action }) => action === "reconcile")).toHaveLength(2);
});

test("does not reserve after expiry and records release acceptance without claiming release proof", async () => {
  // Given
  const item = setup();
  const spec = specification();
  const created = await item.runner.create(spec);
  item.hooks.hold = () => {
    item.state.now = Date.parse(spec.expiresAt);
  };
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)).toMatchObject({
    stage: "expired",
    releaseAccepted: true,
  });
  expect(item.actions.some(({ action }) => action === "reserve")).toBe(false);
  expect(item.actions.find(({ action }) => action === "release")?.stage).toBe("expired");
});

test("checks expiry again after the hold's internal seat read", async () => {
  // Given
  const item = setup();
  const spec = specification();
  const created = await item.runner.create(spec);
  item.hooks.holdRead = () => {
    item.state.now = Date.parse(spec.expiresAt);
  };
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)?.stage).toBe("expired");
  expect(item.actions.some(({ action }) => action === "hold")).toBe(false);
});

test.each(["deadline", "account_changed"] as const)(
  "rechecks %s after the read-only payment preflight",
  async (failure) => {
    const item = setup();
    const spec = specification();
    const created = await item.runner.create(spec);
    item.hooks.checkAvailability = () => {
      if (failure === "deadline") item.state.now = Date.parse(spec.expiresAt);
      else item.state.credentials = { ...item.state.credentials, connectionId: "reconnected" };
    };

    await item.runner.tick();

    expect(item.store.get(created.booking.id)).toMatchObject({
      stage: failure === "deadline" ? "expired" : "failed",
      lastError: failure,
    });
    expect(item.actions.some(({ action }) => action === "hold")).toBe(false);
  },
);

test("does not issue when authorization expires during reservation", async () => {
  // Given
  const item = setup();
  const spec = specification();
  const created = await item.runner.create(spec);
  item.hooks.reserve = () => {
    item.state.now = Date.parse(spec.expiresAt);
  };
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)).toMatchObject({
    stage: "uncertain",
    lastError: "deadline",
  });
  expect(item.actions.some(({ action }) => action === "issue")).toBe(false);
});

test("does not purchase under a switched account", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create(specification());
  item.hooks.prepare = () => {
    item.state.credentials = { ...item.state.credentials, busUserNumber: "other-account" };
  };
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)).toMatchObject({
    stage: "failed",
    lastError: "account_changed",
  });
  expect(item.actions.some(({ action }) => action === "reserve")).toBe(false);
});

test("polls availability again only when the specified interval is due", async () => {
  // Given
  const item = setup();
  item.state.available = false;
  const created = await item.runner.create(specification());
  await item.runner.tick();
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)?.checkCount).toBe(1);
  expect(item.actions.filter(({ action }) => action === "scan")).toHaveLength(1);
  expect(item.state.refreshCount).toBe(0);
});

test("invalidates queued authorization after reconnecting the same GO account", async () => {
  const item = setup();
  const created = await item.runner.create(specification());
  item.state.credentials = {
    ...item.state.credentials,
    connectionId: "synthetic-connection-reconnected",
  };

  await item.runner.tick();

  expect(item.store.get(created.booking.id)).toMatchObject({
    stage: "failed",
    lastError: "account_changed",
  });
  expect(item.actions).toHaveLength(0);
});

test("does not issue after the same GO account reconnects during a delayed reservation", async () => {
  const item = setup();
  const created = await item.runner.create(specification());
  const entered = Promise.withResolvers<void>();
  const leave = Promise.withResolvers<void>();
  item.hooks.reserve = async () => {
    entered.resolve();
    await leave.promise;
  };
  const pending = item.runner.tick();
  await entered.promise;

  item.state.credentials = {
    ...item.state.credentials,
    connectionId: "synthetic-connection-reconnected",
  };
  leave.resolve();
  await pending;

  expect(item.store.get(created.booking.id)).toMatchObject({
    stage: "uncertain",
    lastError: "account_changed",
  });
  expect(item.actions.filter(({ action }) => action === "reserve")).toHaveLength(1);
  expect(item.actions.some(({ action }) => action === "issue")).toBe(false);
  expect(item.store.read(created.booking.id)?.issueAttempted).toBe(false);
});

test("never purchases a result above the authorized budget", async () => {
  // Given
  const item = setup();
  const spec = specification();
  await item.runner.create({ ...spec, criteria: { ...spec.criteria, maxFareKrw: 10000 } });
  // When
  await item.runner.tick();
  // Then
  expect(item.actions.map(({ action }) => action)).toEqual(["scan"]);
  expect(item.state.refreshCount).toBe(0);
});

test("never purchases a trip whose departure has already passed", async () => {
  // Given
  const item = setup();
  await item.runner.create({ ...specification(), expiresAt: "2026-10-30T12:00:00+09:00" });
  item.state.now = Date.parse("2026-10-30T10:01:00+09:00");
  // When
  await item.runner.tick();
  // Then
  expect(item.actions.map(({ action }) => action)).toEqual(["scan"]);
  expect(item.state.refreshCount).toBe(0);
});

test("never falls back when the authorized seat is unavailable", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create({
    ...specification(),
    seatPolicy: { mode: "only", seats: [{ seat: 4, passengerType: "adult" }] },
  });
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)?.stage).toBe("watching");
  expect(item.actions.some(({ action }) => action === "hold")).toBe(false);
});

test("honors descending first available seat order", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create({
    ...specification(),
    seatPolicy: { mode: "first_available", order: "descending", passengerOrder: ["adult"] },
  });
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)?.selection?.seats).toEqual([3]);
});

test("executes the trip selected by caller fare ranking", async () => {
  // Given
  const item = setup();
  const laterCheap = { ...webTrip, departureTime: "110000", tripKey: "later-cheap" };
  const earlierCostly = {
    ...webTrip,
    departureTime: "090000",
    tripKey: "earlier-costly",
    adultFareKrw: 18000,
    totalFareKrw: 18000,
    fareQuotes: { ...webTrip.fareQuotes, adults: { unitFareKrw: 18000, fareKindCode: null } },
  };
  const selected: string[] = [];
  const query = new TripQueryService(
    {
      async searchTripPage() {
        return {
          trips: [earlierCostly, laterCheap],
          unavailable: [],
          continuation: null,
          coverage: "end",
          emptyStatus: "none",
        };
      },
      async getSeats() {
        throw new TypeError("Unexpected seat read");
      },
    },
    () => item.state.now,
  );
  const runner = new BookingRunner({
    ...item.options,
    query,
    bus: {
      ...item.options.bus,
      async findTrip(context, candidate) {
        selected.push(candidate.tripKey);
        return item.options.bus.findTrip(context, candidate);
      },
    },
  });
  const spec = specification();
  await runner.create({
    ...spec,
    criteria: { ...spec.criteria, ranking: ["fare", "departure_time"] },
  });
  // When
  await runner.tick();
  // Then
  expect(selected).toEqual(["later-cheap"]);
  expect(item.store.list()[0]?.stage).toBe("booked");
});

test("exact unavailable seat fails once and idempotency never reattempts it", async () => {
  // Given
  const item = setup();
  const spec = {
    ...specification(),
    seatPolicy: { mode: "only" as const, seats: [{ seat: 4, passengerType: "adult" as const }] },
  };
  // When
  const first = await item.runner.createExact(spec, webTrip);
  const repeated = await item.runner.createExact(spec, webTrip);
  await item.runner.tick();
  // Then
  expect(first.booking).toMatchObject({ stage: "failed", lastError: "trip_unavailable" });
  expect(repeated).toEqual({ ...first, created: false });
  expect(item.actions.some(({ action }) => action === "hold" || action === "scan")).toBe(false);
  expect(item.state.refreshCount).toBe(1);
});
