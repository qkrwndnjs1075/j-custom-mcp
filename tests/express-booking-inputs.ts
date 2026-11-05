import type { Client } from "@modelcontextprotocol/client";
import { z } from "zod";
import { BookingSpecSchema } from "../src/booking-types";
import type { BusProvider } from "../src/bus-provider";
import { ExpressTripSchema, SeatMapSchema } from "../src/provider-types";
import { selection, trip } from "./go-express-fixtures";

export const expressSearch = {
  service: "express",
  departureId: "021",
  arrivalId: "393",
  date: "2026-10-30",
  time: "14:00",
  passengers: { adults: 1, students: 1, children: 1 },
} as const;
export function expressSpec(key = crypto.randomUUID()) {
  return BookingSpecSchema.parse({
    version: 2,
    idempotencyKey: key,
    criteria: {
      ...expressSearch,
      endTime: "14:20",
      minSeats: 3,
      maxFareKrw: 34500,
      ranking: ["departure_time"],
    },
    seatPolicy: { mode: "only", seats: selection },
    payment: { method: "naver_pay_auto" },
    discounts: { mode: "none" },
    intervalSeconds: 300,
    expiresAt: "2026-10-30T14:20:00+09:00",
  });
}
export const publicExpressTrip = ExpressTripSchema.parse({
  service: "express",
  departureId: "021",
  arrivalId: "393",
  departureName: "Central",
  arrivalName: "Seosan",
  departureDate: "20261030",
  departureTime: "142000",
  scheduledDepartureTime: "140000",
  carrierId: "53",
  busClassId: "1",
  carrierName: "Synthetic",
  busClassName: "Synthetic",
  adultCount: 1,
  studentCount: 1,
  childCount: 1,
  remainingSeats: 3,
  totalSeats: null,
  adultFareKrw: null,
  expressIdentity: {
    allocationDepartureId: "020",
    allocationArrivalId: "394",
    discountCode: "0",
    webCheckoutEligible: true,
    privateBusinessAccrual: "N",
    childSafetySeats: "N",
    accessibleSeats: "N",
  },
});
export const publicProvider: BusProvider = {
  async searchTerminals() {
    return [];
  },
  async searchTripPage() {
    return {
      trips: [publicExpressTrip],
      unavailable: [],
      continuation: null,
      coverage: "end",
      emptyStatus: "none",
    };
  },
  async getSeats() {
    return SeatMapSchema.parse({
      adultFareKrw: 15000,
      fareQuotes: trip.fareQuotes,
      seats: [1, 3, 4].map((number) => ({ number, available: true })),
    });
  },
};
export async function quotedReference(client: Client) {
  const search = await client.callTool({ name: "search_trips", arguments: expressSearch });
  const { trips } = z
    .object({ trips: z.array(z.object({ tripRef: z.uuid(), totalFareKrw: z.null() })) })
    .parse(search.structuredContent);
  const tripRef = trips[0]?.tripRef;
  if (!tripRef) throw new TypeError("Missing synthetic trip reference");
  const quote = await client.callTool({ name: "get_seats", arguments: { tripRef } });
  z.object({ service: z.literal("express"), totalFareKrw: z.literal(34500) }).parse(
    quote.structuredContent,
  );
  return tripRef;
}
export function directInput(tripRef: string, key = crypto.randomUUID()) {
  const { criteria, ...spec } = expressSpec(key);
  return { ...spec, tripRef, passengers: criteria.passengers, maxFareKrw: criteria.maxFareKrw };
}
