import { expect, test } from "bun:test";
import { ProviderError } from "../src/provider";
import { parseTrips } from "../src/provider-html";
import { TripQueryService } from "../src/query";
import { TripCriteriaSchema } from "../src/query-types";
import { evaluateWatch } from "../src/watch-evaluator";

const criteria = TripCriteriaSchema.parse({
  service: "intercity",
  departureId: "0000001",
  arrivalId: "0000002",
  date: "2030-01-01",
  time: "00:00",
  endTime: "23:59",
  minSeats: 1,
  passengers: { adults: 1, students: 0, children: 0 },
  ranking: ["departure_time"],
});
test("unexplained empty provider page remains inconclusive at normal watch cadence", async () => {
  const query = new TripQueryService({
    searchTripPage: async () => ({
      trips: [],
      unavailable: [],
      coverage: "end",
      continuation: null,
      emptyStatus: "unknown_empty",
    }),
    getSeats: async () => {
      throw new Error("Unexpected seat query");
    },
  });
  expect(await evaluateWatch(query, criteria, "booking_available")).toEqual({
    kind: "inconclusive",
    reason: "unknown_empty",
  });
});
test("provider network failures keep technical failure backoff", async () => {
  const query = new TripQueryService({
    searchTripPage: async () => {
      throw new ProviderError("network", "offline");
    },
    getSeats: async () => {
      throw new Error("Unexpected seat query");
    },
  });
  expect(await evaluateWatch(query, criteria, "booking_available")).toEqual({
    kind: "unknown",
    reason: "provider_network",
  });
});

test("watch match reports selected passengers and their combined fare", async () => {
  const base = parseTrips(
    await Bun.file(new URL("./fixtures/dispatch.html", import.meta.url)).text(),
  )[0];
  if (!base) throw new Error("Missing fixture trip");
  const query = new TripQueryService({
    searchTripPage: async () => ({
      trips: [
        {
          ...base,
          departureDate: "20300101",
          departureTime: "120000",
          remainingSeats: 3,
          adultFareKrw: 10000,
          adultCount: 1,
          studentCount: 1,
          childCount: 0,
          passengers: { adults: 1, students: 1, children: 0 },
          fareQuotes: {
            adults: { unitFareKrw: 10000, fareKindCode: "adult" },
            students: { unitFareKrw: 8000, fareKindCode: "student" },
            children: null,
          },
        },
      ],
      unavailable: [],
      coverage: "end",
      continuation: null,
      emptyStatus: "none",
    }),
    getSeats: async () => {
      throw new Error("Unexpected seat query");
    },
  });
  const result = await evaluateWatch(
    query,
    {
      ...criteria,
      passengers: { adults: 1, students: 1, children: 0 },
    },
    "booking_available",
  );
  expect(result).toMatchObject({
    kind: "matched",
    matches: [
      {
        adultFareKrw: 10000,
        totalFareKrw: 18000,
        passengers: { adults: 1, students: 1, children: 0 },
        fareQuotes: { students: { unitFareKrw: 8000, fareKindCode: "student" } },
      },
    ],
  });
});

test("express watch evaluation preserves service and a quoted student total without adult fare", async () => {
  // Given
  const { ExpressTripSchema } = await import("../src/provider-types");
  const trip = ExpressTripSchema.parse({
    service: "express",
    departureId: "021",
    arrivalId: "393",
    departureName: "Central",
    arrivalName: "Seosan",
    departureDate: "20300101",
    departureTime: "120000",
    scheduledDepartureTime: "120000",
    carrierId: "01",
    busClassId: "1",
    carrierName: "Synthetic",
    busClassName: "Synthetic",
    adultCount: 0,
    studentCount: 1,
    childCount: 0,
    remainingSeats: 2,
    totalSeats: null,
    adultFareKrw: null,
    fareQuotes: {
      adults: null,
      students: { unitFareKrw: 8000, fareKindCode: "9" },
      children: null,
    },
    expressIdentity: {
      allocationDepartureId: "021",
      allocationArrivalId: "393",
      discountCode: "0",
      webCheckoutEligible: true,
      privateBusinessAccrual: "N",
      childSafetySeats: "N",
      accessibleSeats: "N",
    },
  });
  const selected = TripCriteriaSchema.parse({
    ...criteria,
    service: "express",
    departureId: "021",
    arrivalId: "393",
    passengers: { adults: 0, students: 1, children: 0 },
  });
  const query = new TripQueryService({
    searchTripPage: async () => ({
      trips: [trip],
      unavailable: [],
      coverage: "end",
      continuation: null,
      emptyStatus: "none",
    }),
    getSeats: async () => {
      throw new Error("Unexpected seat query for already quoted trip");
    },
  });
  // When
  const result = await evaluateWatch(query, selected, "booking_available");
  // Then
  expect(result).toMatchObject({
    kind: "matched",
    matches: [
      {
        service: "express",
        adultFareKrw: null,
        totalFareKrw: 8000,
        passengers: { adults: 0, students: 1, children: 0 },
      },
    ],
  });
});
