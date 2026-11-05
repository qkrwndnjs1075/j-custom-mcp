import { parseTrips } from "../src/provider-html";
import { SeatMapSchema, type Trip, type TripPage } from "../src/provider-types";
import { TripCriteriaSchema } from "../src/query-types";

const first = parseTrips(
  await Bun.file(new URL("./fixtures/dispatch.html", import.meta.url)).text(),
)[0];
if (!first) throw new Error("Missing fixture trip");
export const base = first;
export const trip = (
  key: string,
  time = "100000",
  fare = 10000,
  duration: number | null = 60,
): Trip => ({
  ...base,
  departureId: ["before", "early", "return", "return2"].includes(key)
    ? base.arrivalId
    : base.departureId,
  tripKey: key,
  departureTime: time,
  adultFareKrw: fare,
  departureDate: "20261021",
  remainingSeats: 10,
  estimatedDurationMinutes: duration,
});
export const criteria = TripCriteriaSchema.parse({
  service: "intercity",
  departureId: "0000001",
  arrivalId: "0000002",
  date: "2026-10-21",
  time: "00:00",
  endTime: "23:59",
  minSeats: 1,
  passengers: { adults: 1, students: 0, children: 0 },
  ranking: ["fare", "departure_time"],
});
export const page = (trips: readonly Trip[], continuation: string | null = null): TripPage => ({
  trips,
  continuation,
  coverage: continuation ? "more" : "end",
  unavailable: [],
  emptyStatus: "none",
});
export const seats = SeatMapSchema.parse({
  adultFareKrw: 10000,
  layoutStatus: "verified",
  adjacentGroups: [
    [1, 2],
    [3, 4],
    [5, 6, 7],
  ],
  seats: [1, 2, 3, 4, 5, 6, 7].map((number) => ({ number, available: number !== 1 })),
});
export const noSeats = async () => {
  throw new Error("Unexpected seat lookup");
};
