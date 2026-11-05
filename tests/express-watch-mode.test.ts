import { expect, test } from "bun:test";
import { TripQueryService } from "../src/query";
import { evaluateWatch } from "../src/watch-evaluator";
import { WatchRunner } from "../src/watch-runner";
import { WatchStore } from "../src/watch-store";
import { WatchSpecSchema } from "../src/watch-types";
import { ExpressFixtureProvider, expressCriteria, expressTrip } from "./express-test-fixtures";

const base = expressTrip();
const appOnly = expressTrip({
  expressIdentity: { ...base.expressIdentity, webCheckoutEligible: false },
});

test("booking availability excludes an app-only express allocation", async () => {
  // Given a priced, available allocation that the provider forbids on the website.
  const query = new TripQueryService(new ExpressFixtureProvider([appOnly]));
  // When evaluating official booking availability.
  const result = await evaluateWatch(query, expressCriteria, "booking_available");
  // Then an empty eligible set is not reported as matched.
  expect(result).toEqual({ kind: "not_matched" });
});

test("seat availability retains an app-only express allocation", async () => {
  // Given the same website-ineligible allocation with available seats.
  const query = new TripQueryService(new ExpressFixtureProvider([appOnly]));
  // When only seat availability is requested.
  const result = await evaluateWatch(query, expressCriteria, "seats_available");
  // Then native-app eligibility is not inferred from a website restriction.
  expect(result).toMatchObject({
    kind: "matched",
    matches: [{ service: "express", tripKey: appOnly.tripKey }],
  });
});

test("booking availability returns only web-eligible allocations from a mixed result", async () => {
  // Given both eligible and ineligible express departures.
  const eligible = expressTrip({ departureTime: "150000", scheduledDepartureTime: "150000" });
  const query = new TripQueryService(new ExpressFixtureProvider([appOnly, eligible]));
  // When evaluating official booking availability.
  const result = await evaluateWatch(query, expressCriteria, "booking_available");
  // Then the app-only allocation is absent while the eligible one remains actionable.
  expect(result).toMatchObject({ kind: "matched", matches: [{ tripKey: eligible.tripKey }] });
});

test("runner isolates mode evaluations and emits only the seat-availability alert", async () => {
  // Given two simultaneous watches with identical criteria and distinct modes.
  const store = new WatchStore(":memory:", () => Date.parse("2026-10-24T00:00:00Z"));
  const spec = WatchSpecSchema.parse({
    criteria: expressCriteria,
    mode: "seats_available",
    intervalSeconds: 300,
    notification: "on_transition",
    retryPolicy: { mode: "fixed_interval" },
    expiresAt: "2026-10-26T23:00:00+09:00",
  });
  const seats = store.create(spec).watch;
  const booking = store.create({ ...spec, mode: "booking_available" }).watch;
  const query = new TripQueryService(new ExpressFixtureProvider([appOnly]));
  const modes: string[] = [];
  const runner = new WatchRunner({
    store,
    evaluate: (criteria, mode) => {
      modes.push(mode);
      return evaluateWatch(query, criteria, mode);
    },
  });
  try {
    // When one tick evaluates both due watches.
    const result = await runner.tick();
    // Then different modes cannot reuse the same observation.
    expect(result.checked).toBe(2);
    expect(modes.sort()).toEqual(["booking_available", "seats_available"]);
    expect(store.list().find((watch) => watch.id === seats.id)?.lastOutcome).toBe("matched");
    expect(store.list().find((watch) => watch.id === booking.id)?.lastOutcome).toBe("not_matched");
    expect(store.getAlerts({ after: 0, limit: 10 }).alerts.map((alert) => alert.watchId)).toEqual([
      seats.id,
    ]);
  } finally {
    await runner.whenIdle();
    store.close();
  }
});
