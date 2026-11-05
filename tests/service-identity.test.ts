import { expect, test } from "bun:test";
import { type BusProvider, TerminalSearchSchema, TripSearchSchema } from "../src/bus-provider";
import { TmoneyBusClient } from "../src/bus-router";
import type { BusService } from "../src/bus-service";
import { GoBusTripSchema, StoredGoBusTripSchema } from "../src/go-bus-trip-schema";
import { nextContinuation, readContinuation } from "../src/provider-pagination";
import {
  ExpressTripSchema,
  IntercityTripSchema,
  ProviderError,
  SeatMapSchema,
  StoredTripSchema,
  TripSchema,
} from "../src/provider-types";
import { StoredTripCriteriaSchema, TripCriteriaSchema } from "../src/query-types";
import { historicalHold } from "./booking-legacy-fixtures";

const common = {
  departureName: "Synthetic A",
  arrivalName: "Synthetic B",
  departureDate: "20300102",
  departureTime: "120000",
  scheduledDepartureTime: "120000",
  carrierId: "01",
  busClassId: "1",
  carrierName: "Synthetic",
  busClassName: "Synthetic",
  adultCount: 1,
  studentCount: 0,
  childCount: 0,
  remainingSeats: 2,
  totalSeats: 28,
  adultFareKrw: 15000,
};
const oldTrip = {
  ...common,
  departureId: "0000021",
  arrivalId: "0000393",
  routeId: "1",
  routeSequence: "1",
  serviceDate: "20300102",
  serviceSequence: "1",
  discountAvailable: "N",
};
const expressIdentity = {
  allocationDepartureId: "021",
  allocationArrivalId: "393",
  discountCode: "0",
  webCheckoutEligible: true,
  privateBusinessAccrual: "N",
  childSafetySeats: "N",
  accessibleSeats: "N",
};
const intercityTrip = IntercityTripSchema.parse({ ...oldTrip, service: "intercity" });
const expressTrip = ExpressTripSchema.parse({
  ...common,
  service: "express",
  departureId: "021",
  arrivalId: "393",
  expressIdentity,
});
const oldSearch = {
  departureId: "0000021",
  arrivalId: "0000393",
  date: "2030-01-02",
  time: "00:00",
  passengers: { adults: 1, students: 0, children: 0 },
};
const oldCriteria = { ...oldSearch, endTime: "23:59", ranking: ["departure_time"], minSeats: 1 };

function providers() {
  const calls: string[] = [];
  const provider = (service: BusService): BusProvider => ({
    async searchTerminals() {
      calls.push(`${service}:terminals`);
      return [
        {
          service,
          id: service === "express" ? "021" : "0000021",
          name: "Synthetic",
          area: "Synthetic",
        },
      ];
    },
    async searchTripPage() {
      calls.push(`${service}:trips`);
      return {
        trips: [service === "express" ? expressTrip : intercityTrip],
        unavailable: [],
        continuation: null,
        coverage: "end",
        emptyStatus: "none",
      };
    },
    async getSeats() {
      calls.push(`${service}:seats`);
      return SeatMapSchema.parse({ seats: [{ number: 1, available: true }], adultFareKrw: 15000 });
    },
  });
  return { calls, router: new TmoneyBusClient(provider("intercity"), provider("express")) };
}

test("new terminal, trip, criteria and native schemas reject omitted service", () => {
  // Given complete pre-service inputs that succeed only at storage boundaries.
  const cases = [
    TerminalSearchSchema.safeParse({ query: "Synthetic" }),
    TripSearchSchema.safeParse(oldSearch),
    TripCriteriaSchema.safeParse(oldCriteria),
    TripSchema.safeParse(oldTrip),
    GoBusTripSchema.safeParse(historicalHold.trip),
  ];
  // When / Then
  expect(cases.map((result) => result.success)).toEqual([false, false, false, false, false]);
});

test.each(["express", "intercity"] as const)(
  "routes %s terminal, trip and seat inquiries only to the selected provider",
  async (service) => {
    // Given
    const { router, calls } = providers();
    const trip = service === "express" ? expressTrip : intercityTrip;
    // When
    const terminals = await router.searchTerminals({ service, query: "Synthetic" });
    const page = await router.searchTripPage({
      ...oldSearch,
      service,
      departureId: trip.departureId,
      arrivalId: trip.arrivalId,
    });
    await router.getSeats(trip);
    // Then
    expect(calls).toEqual([`${service}:terminals`, `${service}:trips`, `${service}:seats`]);
    expect(terminals[0]?.service).toBe(service);
    expect(page.trips[0]?.service).toBe(service);
  },
);

test.each([
  { service: "express", departureId: "0000021", arrivalId: "0000393" },
  { service: "intercity", departureId: "021", arrivalId: "393" },
  { service: "express", departureId: "021", arrivalId: "0000393" },
  { service: "intercity", departureId: "0000021", arrivalId: "393" },
] as const)("rejects mixed or foreign trip IDs before calling a provider: %j", (route) => {
  // Given
  const { router, calls } = providers();
  const search = { ...oldSearch, ...route };
  // When / Then
  expect(TripSearchSchema.safeParse(search).success).toBe(false);
  expect(TripCriteriaSchema.safeParse({ ...oldCriteria, ...route }).success).toBe(false);
  expect(() => router.searchTripPage(search)).toThrow(ProviderError);
  expect(calls).toEqual([]);
});

test.each([
  { service: "express", departureId: "0000021" },
  { service: "intercity", departureId: "021" },
] as const)("rejects foreign terminal IDs before calling a provider: %j", (route) => {
  // Given
  const { router, calls } = providers();
  const search = { ...route, query: "Synthetic" };
  // When / Then
  expect(TerminalSearchSchema.safeParse(search).success).toBe(false);
  expect(() => router.searchTerminals(search)).toThrow(ProviderError);
  expect(calls).toEqual([]);
});

test("namespaces stable keys for numerically equal terminal codes without collapsing leading zeroes", () => {
  // Given / When
  const keys = [intercityTrip.tripKey, expressTrip.tripKey];
  // Then
  expect(intercityTrip.departureId).toBe("0000021");
  expect(expressTrip.departureId).toBe("021");
  expect(keys[0]?.split(":")[0]).toBe("intercity");
  expect(keys[1]?.split(":")[0]).toBe("express");
  expect(new Set(keys).size).toBe(2);
});

test("storage-only decoders normalize original intercity identities without adding express authority", () => {
  // Given / When
  const trip = StoredTripSchema.parse(oldTrip);
  const criteria = StoredTripCriteriaSchema.parse(oldCriteria);
  const native = StoredGoBusTripSchema.parse(historicalHold.trip);
  // Then
  expect(trip.service).toBe("intercity");
  expect(trip.tripKey).toBe("intercity:1:1:20300102:1:0000021:0000393");
  expect(criteria.service).toBe("intercity");
  expect(native.service).toBe("intercity");
});

test.each(["express", "invalid", null])(
  "storage decoders reject explicit incompatible service %j instead of falling back",
  (service) => {
    // Given / When / Then
    expect(StoredTripSchema.safeParse({ ...oldTrip, service }).success).toBe(false);
    expect(StoredTripCriteriaSchema.safeParse({ ...oldCriteria, service }).success).toBe(false);
    expect(StoredGoBusTripSchema.safeParse({ ...historicalHold.trip, service }).success).toBe(
      false,
    );
  },
);

test("pre-service storage rejects express identity contamination and unknown fields", () => {
  // Given / When / Then
  expect(StoredTripSchema.safeParse({ ...oldTrip, expressIdentity }).success).toBe(false);
  expect(StoredTripSchema.safeParse({ ...oldTrip, unknownFuturePermission: true }).success).toBe(
    false,
  );
  expect(StoredTripCriteriaSchema.safeParse({ ...oldCriteria, expressIdentity }).success).toBe(
    false,
  );
  expect(StoredGoBusTripSchema.safeParse({ ...historicalHold.trip, expressIdentity }).success).toBe(
    false,
  );
});

test("rejects an intercity continuation when only the selected service changes", async () => {
  // Given an authentic-format cursor generated from a local captured page.
  const search = {
    ...oldSearch,
    service: "intercity" as const,
    departureId: "0671801",
    arrivalId: "2839701",
    date: "2026-10-23",
  };
  const html = await Bun.file(new URL("./fixtures/pagination-page1.html", import.meta.url)).text();
  const continuation = nextContinuation(html, search);
  if (continuation === null) throw new TypeError("Fixture must contain continuation");
  expect(readContinuation({ ...search, continuation })?.get("depr_Time")).toBe("152000");
  // When / Then
  expect(() => readContinuation({ ...search, service: "express", continuation })).toThrow(
    ProviderError,
  );
});
