import { afterEach, expect, test } from "bun:test";
import { TripSchema } from "../src/provider-types";
import { context, fixture, info, selection, stopFixtures, trip } from "./go-passenger-fixtures";

afterEach(stopFixtures);

test("carries mixed web passenger composition and total into the matched GO trip", async () => {
  // Given
  const web = TripSchema.parse({
    service: "intercity",
    routeId: "route",
    routeSequence: "01",
    serviceDate: "20261030",
    serviceSequence: "01",
    departureId: "0000001",
    arrivalId: "0000002",
    departureName: "A",
    arrivalName: "B",
    scheduledDepartureTime: "093000",
    carrierId: "03",
    busClassId: "1",
    carrierName: "Carrier",
    busClassName: "Class",
    adultCount: 2,
    studentCount: 1,
    childCount: 1,
    remainingSeats: 4,
    totalSeats: 4,
    departureDate: "20261030",
    departureTime: "093000",
    discountAvailable: "N",
    adultFareKrw: 15000,
    fareQuotes: {
      adults: { unitFareKrw: 15000, fareKindCode: "IG00" },
      students: { unitFareKrw: 7000, fareKindCode: "IM30" },
      children: { unitFareKrw: 7500, fareKindCode: "IC50" },
    },
  });
  const fake = fixture((request) =>
    Response.json(
      request.url.endsWith("selectloadingInfo.do")
        ? { ERR_COD: "00000", TER_LIST: [trip.departureTerminal, trip.arrivalTerminal] }
        : { ERR_COD: "00000", linelist: [trip.row] },
    ),
  );
  // When
  const matched = await fake.bus.findTrip(context, web);
  // Then
  expect(matched).toMatchObject({
    passengers: { adults: 2, students: 1, children: 1 },
    expectedTotalFareKrw: 44500,
    fareQuotes: { students: { unitFareKrw: 7000 } },
  });
});

test("rejects mismatched per-category quotes even when the overall total agrees", async () => {
  // Given
  const fake = fixture(() => Response.json({ ERR_COD: "00000", ...info }));
  const wrongQuotes = {
    ...trip.fareQuotes,
    students: { unitFareKrw: 8000, fareKindCode: "IM30" },
    children: { unitFareKrw: 6500, fareKindCode: "IC50" },
  };
  // When
  const result = fake.bus.hold(context, {
    trip: { ...trip, fareQuotes: wrongQuotes },
    seats: selection,
  });
  // Then
  await expect(result).rejects.toMatchObject({ code: "fare_changed" });
  expect(fake.requests).toHaveLength(1);
});

test("does not substitute university fare when the youth fare is unavailable", async () => {
  // Given
  const fake = fixture(() =>
    Response.json({
      ERR_COD: "00000",
      ...info,
      tckfee91: "0",
      tckfee92: "0",
      tckfee93: "0",
      tckfee8: "7000",
    }),
  );
  // When
  const result = fake.bus.hold(context, { trip, seats: selection });
  // Then
  await expect(result).rejects.toMatchObject({ code: "fare_changed" });
  expect(fake.requests).toHaveLength(1);
});

test("rejects duplicate seat selections before any provider read or mutation", async () => {
  // Given
  const fake = fixture(() => Response.json({ ERR_COD: "00000", ...info }));
  // When
  const result = fake.bus.hold(context, {
    trip,
    seats: [
      { seat: 1, passengerType: "adult" },
      { seat: 1, passengerType: "child" },
    ],
  });
  // Then
  await expect(result).rejects.toMatchObject({ code: "input" });
  expect(fake.requests).toHaveLength(0);
});
