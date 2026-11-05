import { createHash } from "node:crypto";
import { z } from "zod";
import { StoredBookingSpecSchema } from "./booking-spec";

export type { BookingSpec } from "./booking-spec";
export {
  BookingSpecSchema,
  DiscountChoiceSchema,
  PaymentChoiceSchema,
  SeatAssignmentSchema,
  SeatPolicySchema,
} from "./booking-spec";

import { BusServiceSchema } from "./bus-service";
import { GO_MAX_SEAT_NUMBER } from "./go-bus-fares";
import type { GoCredentials } from "./go-credentials";
import { GoPurchaseDiagnosticSchema, GoPurchaseHoldSchema } from "./go-purchase-types";
import { StoredTripSchema } from "./provider-types";

export const BookingStageSchema = z.enum([
  "watching",
  "holding",
  "held",
  "reserving",
  "reserved",
  "issuing",
  "reconciling",
  "booked",
  "cancelled",
  "expired",
  "failed",
  "uncertain",
]);
export type BookingStage = z.infer<typeof BookingStageSchema>;

export const BookingFailureSchema = z.enum([
  "reauthorization_required",
  "account_changed",
  "authentication",
  "query",
  "trip_unavailable",
  "hold_rejected",
  "hold_uncertain",
  "payment_unavailable",
  "reserve_uncertain",
  "issue_uncertain",
  "reconciliation_pending",
  "release_uncertain",
  "deadline",
  "departure_passed",
  "internal",
]);
export type BookingFailure = z.infer<typeof BookingFailureSchema>;
export const BookingSelectionSchema = z
  .object({
    service: BusServiceSchema,
    departureDate: z.string().regex(/^\d{8}$/),
    departureTime: z.string().regex(/^\d{6}$/),
    departureName: z.string().max(256),
    arrivalName: z.string().max(256),
    seat: z.number().int().min(1).max(GO_MAX_SEAT_NUMBER),
    seats: z.array(z.number().int().min(1).max(GO_MAX_SEAT_NUMBER)).readonly().optional(),
    fareKrw: z.number().int().positive(),
  })
  .readonly();

const StoredBookingSelectionSchema = z.union([
  BookingSelectionSchema,
  BookingSelectionSchema.unwrap()
    .omit({ service: true })
    .strict()
    .transform((selection) => ({
      ...selection,
      service: "intercity" as const,
    })),
]);

export const BookingRecordSchema = z
  .object({
    id: z.uuid(),
    spec: StoredBookingSpecSchema,
    exactTrip: StoredTripSchema.optional(),
    stage: BookingStageSchema,
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    revision: z.number().int().nonnegative(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    nextCheckAt: z.number().int(),
    checkCount: z.number().int().nonnegative(),
    lastError: BookingFailureSchema.nullable(),
    failureDiagnostic: GoPurchaseDiagnosticSchema.optional(),
    hold: GoPurchaseHoldSchema.nullable(),
    selection: StoredBookingSelectionSchema.nullable(),
    purchaseMonth: z
      .string()
      .regex(/^\d{6}$/)
      .nullable(),
    paymentOrderNumber: z.string().min(1).max(16384).nullable(),
    receiptBaseline: z.array(z.string().min(1).max(1024)).readonly().nullable().default(null),
    issueAttempted: z.boolean(),
    releaseAccepted: z.boolean().nullable(),
  })
  .refine(
    (record) =>
      record.spec.version !== 2 ||
      ((record.exactTrip === undefined ||
        record.exactTrip.service === record.spec.criteria.service) &&
        (record.hold === null || record.hold.trip.service === record.spec.criteria.service) &&
        (record.selection === null || record.selection.service === record.spec.criteria.service)),
    { message: "Stored trip, hold and selection must match the authorized bus service" },
  )
  .readonly();
export type BookingRecord = z.infer<typeof BookingRecordSchema>;
export type BookingPatch = Partial<
  Pick<
    BookingRecord,
    | "nextCheckAt"
    | "checkCount"
    | "lastError"
    | "failureDiagnostic"
    | "hold"
    | "selection"
    | "purchaseMonth"
    | "paymentOrderNumber"
    | "receiptBaseline"
    | "issueAttempted"
    | "releaseAccepted"
  >
>;

export type BookingCredentials = GoCredentials & { readonly connectionId: string };
export type BookingCredentialAdapter = {
  readonly read: () => Promise<BookingCredentials>;
  readonly refresh: () => Promise<BookingCredentials>;
};

export function bookingBinding(
  credentials: Pick<BookingCredentials, "moappMbrsSno" | "busUserNumber" | "connectionId">,
) {
  if (typeof credentials.connectionId !== "string" || credentials.connectionId.length === 0)
    throw new BookingError("configuration");
  return createHash("sha256")
    .update(
      JSON.stringify([
        credentials.moappMbrsSno,
        credentials.busUserNumber,
        credentials.connectionId,
      ]),
    )
    .digest("hex");
}

export function publicBooking(record: BookingRecord) {
  return {
    id: record.id,
    spec: record.spec,
    stage: record.stage,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    nextCheckAt: new Date(record.nextCheckAt).toISOString(),
    checkCount: record.checkCount,
    lastError: record.lastError,
    selection: record.selection,
    releaseAccepted: record.releaseAccepted,
  };
}
export type Booking = ReturnType<typeof publicBooking>;

const errorMessages = {
  invalid_reference: "Trip reference is unavailable or does not match passenger authorization.",
  invalid_interval: "Polling interval is outside service limits.",
  invalid_spec: "Booking authorization is invalid.",
  capacity: "Booking record capacity reached; existing financial records are preserved.",
  expired: "Booking authorization has expired.",
  duplicate_key: "Idempotency key is already bound to a different authorization or account.",
  configuration: "Booking storage or account configuration is invalid.",
} as const;
export class BookingError extends Error {
  override readonly name = "BookingError";
  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
  }
}

export const bookingTransitions: Readonly<Record<BookingStage, readonly BookingStage[]>> = {
  watching: ["watching", "holding", "cancelled", "expired", "failed"],
  holding: ["held", "expired", "failed", "uncertain"],
  held: ["reserving", "expired", "failed", "uncertain"],
  reserving: ["reserved", "uncertain"],
  reserved: ["issuing", "uncertain"],
  issuing: ["reconciling", "uncertain"],
  reconciling: ["booked", "uncertain"],
  uncertain: ["reconciling", "uncertain"],
  booked: [],
  cancelled: [],
  expired: ["expired"],
  failed: ["failed"],
};
