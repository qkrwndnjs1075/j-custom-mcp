import { expect, test } from "bun:test";
import { ProviderError, SeatMapSchema } from "../src/provider-types";
import { TripQueryService } from "../src/query";
import { TripCriteriaSchema } from "../src/query-types";
import { criteria, noSeats, page, seats, trip } from "./query-fixtures";

test("inclusive pagination deduplicates and preserves later departures", async () => {
  const requests: (string | undefined)[] = [];
  const service = new TripQueryService({
    searchTripPage: async (search) => {
      requests.push(search.continuation);
      return requests.length === 1 ? page([trip("a")], "next") : page([trip("a"), trip("b")]);
    },
    getSeats: noSeats,
  });
  const result = await service.scan(criteria);
  expect(result.matches.map((match) => match.trip.tripKey)).toEqual(["a", "b"]);
  expect(requests).toEqual([undefined, "next"]);
  expect(result.complete).toBe(true);
});

test("time, exact departure, fare and seat filters compose; preference ranks before fare", async () => {
  const service = new TripQueryService({
    searchTripPage: async () =>
      page([
        trip("early", "090000"),
        trip("cheap", "100000", 5000),
        trip("preferred", "110000", 9000),
        trip("late", "120000"),
        trip("expensive", "110000", 20000),
        { ...trip("few", "110000"), remainingSeats: 1 },
      ]),
    getSeats: noSeats,
  });
  const filter = {
    ...criteria,
    time: "10:00",
    endTime: "11:00",
    maxFareKrw: 10000,
    minSeats: 2,
    preferredTime: "11:00",
    ranking: ["preferred_time", "fare"] as const,
  };
  expect((await service.scan(filter)).matches.map((match) => match.trip.tripKey)).toEqual([
    "preferred",
    "cheap",
  ]);
  expect(
    (await service.scan({ ...filter, departureTime: "11:00" })).matches.map(
      (match) => match.trip.tripKey,
    ),
  ).toEqual(["preferred"]);
});

test("repeated continuation, no progress, unknown empty and provider failures preserve honest partial results", async () => {
  for (const mode of ["repeat", "stalled", "empty", "failure"]) {
    let calls = 0;
    const service = new TripQueryService({
      searchTripPage: async () => {
        if (++calls === 1) return page([trip("a")], "next");
        if (mode === "failure") throw new ProviderError("timeout", "timeout");
        if (mode === "empty") return { ...page([]), emptyStatus: "unknown_empty" };
        return page([trip("a")], mode === "repeat" ? "next" : "other");
      },
      getSeats: noSeats,
    });
    const result = await service.scan(criteria);
    expect(result.complete).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.matches).toHaveLength(1);
    expect(calls).toBe(2);
  }
});

test("adjacency uses available contiguous windows inside verified groups only", async () => {
  const service = new TripQueryService({
    searchTripPage: async () => page([trip("a")]),
    getSeats: async () => seats,
  });
  expect(
    (await service.scan({ ...criteria, adjacentSeats: 2 })).matches[0]?.adjacentSeatGroups,
  ).toEqual([
    [3, 4],
    [5, 6],
    [6, 7],
  ]);
  const unknown = new TripQueryService({
    searchTripPage: async () => page([trip("a")]),
    getSeats: async () => ({ ...seats, layoutStatus: "unknown" }),
  });
  expect(await unknown.scan({ ...criteria, adjacentSeats: 2 })).toEqual({
    matches: [],
    complete: false,
    reasons: ["unknown_seat_layout"],
  });
});

test("seat lookup refreshes fare and capacity and applies the current fare cap", async () => {
  const service = new TripQueryService({
    searchTripPage: async () => page([trip("a", "100000", 5000)]),
    getSeats: async () => seats,
  });
  const result = await service.scan({ ...criteria, adjacentSeats: 2 });
  expect(result.matches[0]?.trip.adultFareKrw).toBe(10000);
  expect(result.matches[0]?.trip.remainingSeats).toBe(6);
  expect((await service.scan({ ...criteria, adjacentSeats: 2, maxFareKrw: 6000 })).matches).toEqual(
    [],
  );
});

test("mixed passenger total drives filtering and ranking using returned per-type prices", async () => {
  // Given: the cheaper adult fare has the more expensive mixed total.
  const passengers = { adults: 1, students: 1, children: 1 };
  const received: unknown[] = [];
  const service = new TripQueryService({
    searchTripPage: async (input) => {
      received.push(input.passengers);
      return page(
        [trip("adult-cheap", "100000", 1000), trip("total-cheap", "110000", 2000)].map(
          (source) => ({ ...source, adultCount: 1, studentCount: 1, childCount: 1, passengers }),
        ),
      );
    },
    getSeats: async (selected) =>
      SeatMapSchema.parse({
        adultFareKrw: selected.adultFareKrw,
        fareQuotes: {
          adults: { unitFareKrw: selected.adultFareKrw, fareKindCode: "IG00" },
          students: {
            unitFareKrw: selected.tripKey === "adult-cheap" ? 9000 : 1000,
            fareKindCode: "IM20",
          },
          children: { unitFareKrw: 500, fareKindCode: "IC50" },
        },
        seats: [1, 2, 3].map((number) => ({ number, available: true })),
      }),
  });
  // When: scan with a group fare cap.
  const result = await service.scan({ ...criteria, passengers, maxFareKrw: 5000 });
  // Then: only the affordable group survives; provider receives the composition.
  expect(result.matches.map(({ trip }) => [trip.tripKey, trip.totalFareKrw])).toEqual([
    ["total-cheap", 3500],
  ]);
  expect(received).toEqual([passengers]);
});

test("ranking uses only caller keys and keeps ties in provider order", async () => {
  // Given: equal fare trips arrive in reverse departure order.
  const service = new TripQueryService({
    searchTripPage: async () => page([trip("later", "120000"), trip("earlier", "100000")]),
    getSeats: noSeats,
  });
  // When: fare is the sole ranking key.
  const result = await service.scan({ ...criteria, ranking: ["fare"] });
  // Then: no departure-time tie breaker is added.
  expect(result.matches.map(({ trip }) => trip.tripKey)).toEqual(["later", "earlier"]);
});

test("new criteria reject omitted passenger and ordering decisions", () => {
  // Given: a route without product choices.
  const input = {
    service: "intercity",
    departureId: "0000001",
    arrivalId: "0000002",
    date: "2026-10-21",
  };
  // When: parse the new public contract.
  const result = TripCriteriaSchema.safeParse(input);
  // Then: it cannot silently become an adult-only cheapest search.
  expect(result.success).toBe(false);
});

test("passenger and fare sums reject unsafe integer arithmetic", async () => {
  // Given: individually safe values whose sum or product exceeds safe integer range.
  const { PassengersSchema, totalFare } = await import("../src/passengers");
  // When: parse a passenger count and compute a selected fare.
  const count = PassengersSchema.safeParse({
    adults: Number.MAX_SAFE_INTEGER,
    students: 1,
    children: 0,
  });
  const fare = totalFare(
    { adults: 2, students: 0, children: 0 },
    {
      adults: { unitFareKrw: Number.MAX_SAFE_INTEGER, fareKindCode: null },
      students: null,
      children: null,
    },
  );
  // Then: neither rounded result can authorize a budget decision.
  expect(count.success).toBe(false);
  expect(fare).toBeNull();
});

test("query rejects provider passenger composition mismatch before accepting fares", async () => {
  // Given: provider ignores the requested mixed passenger composition.
  const service = new TripQueryService({
    searchTripPage: async () => page([trip("adult-only")]),
    getSeats: noSeats,
  });
  // When: searching for an adult and student.
  const result = await service.scan({
    ...criteria,
    passengers: { adults: 1, students: 1, children: 0 },
  });
  // Then: the source is rejected instead of overwriting its counts with the request.
  expect(result).toEqual({ matches: [], complete: false, reasons: ["passenger_mismatch"] });
});
