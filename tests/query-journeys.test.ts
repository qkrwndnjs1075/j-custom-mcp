import { expect, test } from "bun:test";
import { TripQueryService } from "../src/query";
import { JourneySearchSchema } from "../src/query-types";
import { base, criteria, noSeats, page, trip } from "./query-fixtures";

test("journeys enforce arrival chronology across midnight, adult fare and truncation", async () => {
  let calls = 0;
  const service = new TripQueryService({
    searchTripPage: async () =>
      ++calls % 2 === 1
        ? page([trip("out", "230000", 8000, 120)])
        : page([
            trip("before", "233000", 1000),
            { ...trip("early", "003000", 1000), departureDate: "20261022" },
            { ...trip("return", "010000", 2000), departureDate: "20261022" },
            { ...trip("return2", "020000", 3000), departureDate: "20261022" },
          ]),
    getSeats: noSeats,
  });
  const input = JourneySearchSchema.parse({
    ranking: ["total_fare"],
    legs: [criteria, { ...criteria, date: "2026-10-22" }],
    maxResults: 1,
  });
  const result = await service.findJourneys(input);
  expect(result.journeys[0]?.legs.map((match) => match.trip.tripKey)).toEqual(["out", "return"]);
  expect(result.journeys[0]?.totalFareKrw).toBe(10000);
  expect(result.reasons).toContain("max_results");
  expect((await service.findJourneys({ ...input, maxTotalFareKrw: 9000 })).journeys).toHaveLength(
    0,
  );
});

test("unknown connection duration excludes uncertain combinations with a reason", async () => {
  let calls = 0;
  const service = new TripQueryService({
    searchTripPage: async () =>
      page([++calls === 1 ? trip("out", "100000", 1000, null) : trip("return", "200000")]),
    getSeats: noSeats,
  });
  const result = await service.findJourneys(
    JourneySearchSchema.parse({
      ranking: ["total_fare"],
      legs: [criteria, criteria],
      maxResults: 10,
    }),
  );
  expect(result.journeys).toEqual([]);
  expect(result.reasons).toContain("unknown_connection_duration");
  expect(result.complete).toBe(false);
});

test("disconnected legs never produce a journey", async () => {
  const service = new TripQueryService({
    searchTripPage: async () => page([trip("disconnected", "200000")]),
    getSeats: noSeats,
  });
  expect(
    (
      await service.findJourneys(
        JourneySearchSchema.parse({
          ranking: ["total_fare"],
          legs: [criteria, criteria],
          maxResults: 10,
        }),
      )
    ).journeys,
  ).toEqual([]);
});

test("configured journey leg limit permits three connected legs", async () => {
  // Given: three connected departures and a service allowing three legs.
  const { DEFAULT_SERVICE_LIMITS } = await import("../src/service-limits");
  let index = 0;
  const service = new TripQueryService(
    {
      searchTripPage: async () => {
        index++;
        return page([
          {
            ...trip(String(index), `${10 + index}0000`),
            departureId: base.departureId,
            arrivalId: base.departureId,
          },
        ]);
      },
      getSeats: noSeats,
    },
    () => 0,
    { ...DEFAULT_SERVICE_LIMITS, journeyLegs: 3 },
  );
  // When: a three-leg plan is requested.
  const result = await service.findJourneys(
    JourneySearchSchema.parse({
      ranking: ["total_fare"],
      legs: [criteria, criteria, criteria],
      maxResults: 1,
    }),
  );
  // Then: all three legs appear and their selected totals are summed.
  expect(result.journeys[0]?.legs).toHaveLength(3);
  expect(result.journeys[0]?.totalFareKrw).toBe(30000);
});

test("journey combination budget bounds intermediate growth and reports partial coverage", async () => {
  // Given: two connected alternatives on each of four legs create sixteen combinations.
  const { DEFAULT_SERVICE_LIMITS } = await import("../src/service-limits");
  let leg = 0;
  const service = new TripQueryService(
    {
      searchTripPage: async () => {
        leg++;
        return page(
          ["a", "b"].map((key) => ({
            ...trip(`${leg}-${key}`, `${10 + leg}0000`),
            departureId: base.departureId,
            arrivalId: base.departureId,
          })),
        );
      },
      getSeats: noSeats,
    },
    () => 0,
    { ...DEFAULT_SERVICE_LIMITS, journeyCombinations: 2 },
  );
  // When: expansion is limited to two candidate pairs per leg.
  const result = await service.findJourneys(
    JourneySearchSchema.parse({
      ranking: ["total_fare"],
      legs: [criteria, criteria, criteria, criteria],
      maxResults: 20,
    }),
  );
  // Then: returned combinations stay bounded and cannot imply globally complete ranking.
  expect(result.journeys).toHaveLength(2);
  expect(result.journeys.every((journey) => journey.legs.length === 4)).toBe(true);
  expect(result.complete).toBe(false);
  expect(result.reasons).toContain("combination_limit");
});

test.each([
  { ranking: ["total_fare"], expected: ["higher-outbound", "return"], total: 6000 },
  { ranking: ["leg_order"], expected: ["cheap-outbound", "return2"], total: 11000 },
  { ranking: ["total_preferred_time"], expected: ["cheap-outbound", "return2"], total: 11000 },
])("journey ranking follows explicit whole-journey keys: %j", async (scenario) => {
  // Given: cheap outbound arrives after the cheap return leaves; expensive outbound connects.
  let calls = 0;
  const service = new TripQueryService({
    searchTripPage: async () =>
      ++calls === 1
        ? page([
            trip("cheap-outbound", "110000", 1000, 120),
            trip("higher-outbound", "100000", 5000, 60),
          ])
        : page([trip("return", "120000", 1000), trip("return2", "140000", 10000)]),
    getSeats: noSeats,
  });
  // When: rank complete connected journeys using the caller's choice.
  const result = await service.findJourneys(
    JourneySearchSchema.parse({
      legs: [
        { ...criteria, preferredTime: "11:00" },
        { ...criteria, preferredTime: "14:00" },
      ],
      ranking: scenario.ranking,
      maxResults: 10,
    }),
  );
  // Then: fare ranking optimizes total cost while explicit leg/preference rankings differ.
  expect(result.complete).toBe(true);
  expect(result.journeys[0]?.legs.map(({ trip }) => trip.tripKey)).toEqual([...scenario.expected]);
  expect(result.journeys[0]?.totalFareKrw).toBe(scenario.total);
  expect(result.journeys).toHaveLength(3);
});

test("journey ranking rejects missing keys and incomplete preference targets", () => {
  // Given: a valid leg and result count without whole-journey ranking.
  const input = { legs: [criteria], maxResults: 10 };
  // When: validate missing, duplicate and unsupported preferred-time decisions.
  const parsed = [
    JourneySearchSchema.safeParse(input),
    JourneySearchSchema.safeParse({ ...input, ranking: ["total_fare", "total_fare"] }),
    JourneySearchSchema.safeParse({ ...input, ranking: ["total_preferred_time"] }),
  ];
  // Then: no implicit whole-journey ordering or missing time target is accepted.
  expect(parsed.map((result) => result.success)).toEqual([false, false, false]);
});
