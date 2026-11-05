import { z } from "zod";
import { GoCancellationQuoteSchema } from "./go-ticket-types";
import type { ServiceLimits } from "./service-limits";

export type CancellationLimits = Pick<
  ServiceLimits,
  | "cancellationQuotes"
  | "cancellationQuoteTtlSeconds"
  | "retainedCancellations"
  | "activeCancellations"
>;
export type CancellationStoreOptions = {
  readonly now?: () => number;
  readonly limits?: CancellationLimits;
};

export const CancellationSpecSchema = z
  .strictObject({
    quoteRef: z.uuid(),
    idempotencyKey: z.uuid(),
    acceptedFeeKrw: z.number().int().nonnegative().safe(),
  })
  .readonly();
export type CancellationSpec = z.infer<typeof CancellationSpecSchema>;
export const CancellationErrorCodeSchema = z.enum([
  "invalid_reference",
  "invalid_spec",
  "expired",
  "fee_changed",
  "account_changed",
  "duplicate_key",
  "target_busy",
  "capacity",
  "configuration",
  "unsupported",
  "response",
  "authentication",
  "uncertain",
  "reconciliation_pending",
]);
export type CancellationErrorCode = z.infer<typeof CancellationErrorCodeSchema>;
export class CancellationError extends Error {
  override readonly name = "CancellationError";
  constructor(readonly code: CancellationErrorCode) {
    super(code);
  }
}
const timestamp = z.number().int().nonnegative().safe();
export const CancellationBindingSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const CancellationQuoteRecordSchema = z
  .strictObject({
    id: z.uuid(),
    bindingHash: CancellationBindingSchema,
    createdAt: timestamp,
    expiresAt: timestamp,
    quote: GoCancellationQuoteSchema,
  })
  .refine((record) => record.expiresAt > record.createdAt)
  .readonly();
export type CancellationQuoteRecord = z.infer<typeof CancellationQuoteRecordSchema>;
export const CancellationStageSchema = z.enum([
  "prepared",
  "submitting",
  "uncertain",
  "cancelled",
  "failed",
]);
export type CancellationStage = z.infer<typeof CancellationStageSchema>;
export const CancellationOutcomeSchema = z
  .strictObject({
    status: z.literal("confirmed"),
    feeKrw: z.number().int().nonnegative().safe(),
    refundKrw: z.number().int().nonnegative().safe(),
    cancelledAt: z.string().min(1).max(128),
  })
  .readonly();
export const CancellationRecordSchema = z
  .strictObject({
    id: z.uuid(),
    spec: CancellationSpecSchema,
    bindingHash: CancellationBindingSchema,
    quote: GoCancellationQuoteSchema,
    stage: CancellationStageSchema,
    revision: z.number().int().nonnegative().safe(),
    createdAt: timestamp,
    updatedAt: timestamp,
    nextCheckAt: timestamp,
    lastError: CancellationErrorCodeSchema.nullable(),
    outcome: CancellationOutcomeSchema.optional(),
  })
  .refine((record) => record.quote.feeKrw === record.spec.acceptedFeeKrw)
  .refine((record) => (record.stage === "cancelled") === (record.outcome !== undefined))
  .readonly();
export type CancellationRecord = z.infer<typeof CancellationRecordSchema>;
export type CancellationPatch = Readonly<
  Partial<Pick<CancellationRecord, "nextCheckAt" | "lastError" | "outcome">>
>;
export const cancellationTransitions: Readonly<
  Record<CancellationStage, readonly CancellationStage[]>
> = {
  prepared: ["failed"],
  submitting: ["uncertain", "cancelled"],
  uncertain: ["uncertain", "cancelled"],
  cancelled: [],
  failed: [],
};
export function publicCancellation(record: CancellationRecord) {
  const { ticket } = record.quote;
  return {
    cancellationId: record.id,
    spec: record.spec,
    service: ticket.service,
    trip: {
      departureDate: ticket.departureDate,
      departureTime: ticket.departureTime,
      departureId: ticket.departureId,
      arrivalId: ticket.arrivalId,
      departureName: ticket.departureName,
      arrivalName: ticket.arrivalName,
    },
    seats: record.quote.selectedSeats,
    stage: record.stage,
    quotedFeeKrw: record.quote.feeKrw,
    quotedRefundKrw: record.quote.refundKrw,
    actualFeeKrw: record.outcome?.feeKrw ?? null,
    actualRefundKrw: record.outcome?.refundKrw ?? null,
    feeChanged: record.outcome ? record.outcome.feeKrw !== record.spec.acceptedFeeKrw : false,
    cancelledAt: record.outcome?.cancelledAt ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextCheckAt: record.nextCheckAt,
    lastError: record.lastError,
  };
}
export type Cancellation = ReturnType<typeof publicCancellation>;
