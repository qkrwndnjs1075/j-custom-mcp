import { z } from "zod";
import { GO_MAX_SEAT_NUMBER, GO_PURCHASE_CAPABILITIES } from "./go-bus-fares";
import { passengerCount } from "./passengers";
import { PreServiceTripCriteriaSchema, TripCriteriaSchema } from "./query-types";
import { watchDeadline } from "./watch-types";

const PassengerTypeSchema = z.enum(GO_PURCHASE_CAPABILITIES.passengerTypes);
export const SeatAssignmentSchema = z
  .strictObject({
    seat: z.number().int().min(1).max(GO_MAX_SEAT_NUMBER),
    passengerType: PassengerTypeSchema,
  })
  .readonly();
export const SeatPolicySchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("only"),
    seats: z
      .array(SeatAssignmentSchema)
      .min(1)
      .max(GO_MAX_SEAT_NUMBER)
      .refine((seats) => new Set(seats.map((value) => value.seat)).size === seats.length)
      .readonly(),
  }),
  z.strictObject({
    mode: z.literal("first_available"),
    order: z.enum(["ascending", "descending"]),
    passengerOrder: z.array(PassengerTypeSchema).min(1).max(GO_MAX_SEAT_NUMBER).readonly(),
  }),
]);
export const PaymentChoiceSchema = z.strictObject({
  method: z.enum(GO_PURCHASE_CAPABILITIES.paymentMethods),
});
export const DiscountChoiceSchema = z.strictObject({
  mode: z.enum(GO_PURCHASE_CAPABILITIES.discountModes),
});
export const BookingSpecSchema = z
  .strictObject({
    version: z.literal(2),
    idempotencyKey: z.uuid(),
    criteria: TripCriteriaSchema.and(
      z.object({ maxFareKrw: z.number().int().positive(), adjacentSeats: z.never().optional() }),
    ),
    expiresAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
    intervalSeconds: z.number().int().positive().safe(),
    seatPolicy: SeatPolicySchema,
    payment: PaymentChoiceSchema,
    discounts: DiscountChoiceSchema,
  })
  .refine((spec) => Date.parse(spec.expiresAt) <= Date.parse(watchDeadline(spec.criteria)))
  .refine((spec) => spec.criteria.minSeats >= passengerCount(spec.criteria.passengers))
  .refine(
    (spec) =>
      spec.seatPolicy.mode !== "only" ||
      spec.seatPolicy.seats.length === passengerCount(spec.criteria.passengers),
  )
  .refine((spec) => {
    const types =
      spec.seatPolicy.mode === "only"
        ? spec.seatPolicy.seats.map((seat) => seat.passengerType)
        : spec.seatPolicy.passengerOrder;
    return (
      types.filter((type) => type === "adult").length === spec.criteria.passengers.adults &&
      types.filter((type) => type === "student").length === spec.criteria.passengers.students &&
      types.filter((type) => type === "child").length === spec.criteria.passengers.children
    );
  })
  .readonly();
const PreServiceBookingSpecSchema = z
  .strictObject({
    ...BookingSpecSchema.unwrap().shape,
    criteria: PreServiceTripCriteriaSchema.and(
      z.object({ maxFareKrw: z.number().int().positive(), adjacentSeats: z.never().optional() }),
    ),
  })
  .transform(
    (spec): z.input<typeof BookingSpecSchema> => ({
      ...spec,
      criteria: { ...spec.criteria, service: "intercity" as const },
    }),
  )
  .pipe(BookingSpecSchema);
export type BookingSpec = z.infer<typeof BookingSpecSchema>;

// Historical authorizations are decoded without granting the new explicit permissions.
const LegacyBookingSpecSchema = z
  .strictObject({
    version: z.literal(1).optional(),
    idempotencyKey: z.uuid(),
    criteria: z.strictObject({
      departureId: z.string(),
      arrivalId: z.string(),
      date: z.string(),
      time: z.string(),
      endTime: z.string(),
      maxFareKrw: z.number(),
      minSeats: z.number(),
      preferredTime: z.string().optional(),
      departureTime: z.string().optional(),
    }),
    expiresAt: z.string(),
    intervalSeconds: z.number().int().positive(),
    preferredSeats: z.array(z.number()).readonly().optional(),
  })
  .readonly();

export const StoredBookingSpecSchema = z.union([
  BookingSpecSchema,
  PreServiceBookingSpecSchema,
  LegacyBookingSpecSchema,
]);
