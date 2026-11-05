import { z } from "zod";
import { FareQuotesSchema, PassengersSchema, totalFare } from "./passengers";

const identifier = z.string().min(1);
const integer = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative().safe()),
]);
const common = z.object({
  departureId: identifier,
  arrivalId: identifier,
  departureName: z.string().min(1),
  arrivalName: z.string().min(1),
  departureDate: z.string().regex(/^\d{8}$/),
  departureTime: z.string().regex(/^\d{6}$/),
  scheduledDepartureTime: z.string().regex(/^\d{6}$/),
  carrierId: identifier,
  busClassId: identifier,
  carrierName: z.string().min(1),
  busClassName: z.string().min(1),
  adultCount: integer,
  studentCount: integer,
  childCount: integer,
  remainingSeats: integer,
  totalSeats: integer.refine((value) => value > 0).nullable(),
  adultFareKrw: integer.nullable(),
  fareQuotes: FareQuotesSchema.optional(),
  estimatedDurationMinutes: z.number().int().nonnegative().nullable().default(null),
});
const intercity = common.extend({
  service: z.literal("intercity"),
  routeId: identifier,
  routeSequence: identifier,
  serviceDate: z.string().regex(/^\d{8}$/),
  serviceSequence: identifier,
  departureId: z.string().regex(/^\d{7}$/),
  arrivalId: z.string().regex(/^\d{7}$/),
  adultFareKrw: integer,
  totalSeats: integer.refine((value) => value > 0),
  discountAvailable: z.enum(["Y", "N"]),
});
const express = common.extend({
  service: z.literal("express"),
  departureId: z.string().regex(/^\d{3}$/),
  arrivalId: z.string().regex(/^\d{3}$/),
  expressIdentity: z
    .strictObject({
      allocationDepartureId: z.string().regex(/^\d{3}$/),
      allocationArrivalId: z.string().regex(/^\d{3}$/),
      discountCode: z.string().regex(/^\d+$/),
      webCheckoutEligible: z.boolean(),
      privateBusinessAccrual: z.enum(["Y", "N"]),
      childSafetySeats: z.enum(["Y", "N"]),
      accessibleSeats: z.enum(["Y", "N"]),
    })
    .readonly(),
});
const rawTrip = z.discriminatedUnion("service", [intercity, express]);

function enrichTrip<T extends z.infer<typeof rawTrip>>(trip: T) {
  const passengers = {
    adults: trip.adultCount,
    students: trip.studentCount,
    children: trip.childCount,
  };
  const fareQuotes = trip.fareQuotes ?? {
    adults:
      trip.adultFareKrw === null ? null : { unitFareKrw: trip.adultFareKrw, fareKindCode: null },
    students: null,
    children: null,
  };
  const identity = tripIdentity(trip);
  return {
    ...trip,
    passengers,
    fareQuotes,
    totalFareKrw: totalFare(passengers, fareQuotes),
    tripKey: [trip.service, ...identity].join(":"),
    availability: trip.remainingSeats > 0 ? ("available" as const) : ("sold_out" as const),
  };
}

function tripIdentity(trip: z.infer<typeof rawTrip>): readonly string[] {
  switch (trip.service) {
    case "intercity":
      return [
        trip.routeId,
        trip.routeSequence,
        trip.serviceDate,
        trip.serviceSequence,
        trip.departureId,
        trip.arrivalId,
      ];
    case "express":
      return [
        trip.departureDate,
        trip.departureTime,
        trip.scheduledDepartureTime,
        trip.departureId,
        trip.arrivalId,
        trip.expressIdentity.allocationDepartureId,
        trip.expressIdentity.allocationArrivalId,
        trip.carrierId,
        trip.busClassId,
      ];
  }
}

export const IntercityTripSchema = intercity.transform(enrichTrip).readonly();
export const ExpressTripSchema = express.transform(enrichTrip).readonly();
export const TripSchema = z.union([IntercityTripSchema, ExpressTripSchema]);
export type IntercityTrip = z.infer<typeof IntercityTripSchema>;
export type ExpressTrip = z.infer<typeof ExpressTripSchema>;
export type Trip = z.infer<typeof TripSchema>;

const preServiceTrip = intercity
  .omit({ service: true })
  .extend({
    service: z.never().optional(),
    passengers: PassengersSchema.optional(),
    totalFareKrw: z.number().int().nonnegative().nullable().optional(),
    tripKey: z.string().min(1).optional(),
    availability: z.enum(["available", "sold_out"]).optional(),
  })
  .strict()
  .transform((trip): z.input<typeof IntercityTripSchema> => ({ ...trip, service: "intercity" }))
  .pipe(IntercityTripSchema);
export const StoredTripSchema = z.union([TripSchema, preServiceTrip]);
