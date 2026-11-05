import { createHash } from "node:crypto";
import { z } from "zod";
import type { GoBusContext } from "./go-bus-types";
import { cancellationMutationBody } from "./go-cancel-payload";

const text = z.string().min(1).max(1024);
const amount = z.number().int().nonnegative().safe();
const seats = z
  .array(z.number().int().min(1).max(98))
  .min(1)
  .max(98)
  .refine((values) => new Set(values).size === values.length)
  .readonly();
export const GoTicketSchema = z
  .strictObject({
    service: z.enum(["intercity", "express"]),
    lineNumber: text,
    sortDate: text,
    ownerUserNumber: text,
    // Legacy snapshots remain readable, but cannot authorize provider operations.
    accountBinding: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    departureDate: z.string().regex(/^\d{8}$/),
    departureTime: z.string().regex(/^\d{6}$/),
    departureId: text,
    arrivalId: text,
    departureName: text,
    arrivalName: text,
    paymentCode: text,
    statusCode: text,
    count: z.number().int().min(1).max(98),
  })
  .readonly();
export type GoTicket = z.infer<typeof GoTicketSchema>;
export type GoTicketAccount = {
  readonly bindingHash: string;
  readonly context: GoBusContext;
  readonly memberSerialNumber: string;
};
export function ticketBelongsToAccount(ticket: GoTicket, account: GoTicketAccount): boolean {
  return ticket.accountBinding !== undefined && ticket.accountBinding === account.bindingHash;
}
export const GoCancellationSelectionSchema = z
  .strictObject({
    ticket: GoTicketSchema,
    selection: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("all") }).readonly(),
      z.strictObject({ mode: z.literal("seats"), seats }).readonly(),
    ]),
  })
  .readonly();
export type GoCancellationSelection = z.infer<typeof GoCancellationSelectionSchema>;
export const GoTicketIdentitySchema = z
  .strictObject({
    seat: z.number().int().min(1).max(98),
    ticketSequence: text,
    issuanceId: text,
    actDate: z.string().max(1024),
    ticketTerminal: z.string().max(1024),
    ticketWindow: z.string().max(1024),
    publicationDate: z.string().max(1024),
    publicationTerminal: z.string().max(1024),
    publicationWindow: z.string().max(1024),
    publicationNumber: z.string().max(1024),
  })
  .readonly();
export type GoTicketIdentity = z.infer<typeof GoTicketIdentitySchema>;
export function cancellationTargetKey(
  ticket: GoTicket,
  orderNumber: string,
  selected: readonly GoTicketIdentity[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([ticket.service, ticket.lineNumber, orderNumber, selected]))
    .digest("hex");
}
export const GoCancellationQuoteSchema = z
  .strictObject({
    ticket: GoTicketSchema,
    selectedSeats: seats,
    feeKrw: amount,
    refundKrw: amount,
    quotedAt: z.number().int().nonnegative().max(253402268399999),
    targetKey: z.string().regex(/^[a-f0-9]{64}$/),
    orderNumber: text,
    publicationDivision: text,
    selected: z.array(GoTicketIdentitySchema).min(1).max(98).readonly(),
    remaining: z.array(GoTicketIdentitySchema).max(98).readonly(),
    historyBaseline: z.array(text).readonly(),
    payload: z.record(z.string(), z.string()).readonly(),
  })
  .refine((quote) => {
    const identities = [...quote.selected, ...quote.remaining];
    const normalizedPayload = (payload: Readonly<Record<string, string>>) =>
      JSON.stringify(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
    return (
      quote.ticket.paymentCode === "N" &&
      quote.ticket.statusCode === "1" &&
      identities.length === quote.ticket.count &&
      new Set(identities.map((row) => row.seat)).size === identities.length &&
      new Set(identities.map((row) => row.issuanceId)).size === identities.length &&
      quote.selectedSeats.length === quote.selected.length &&
      quote.selected.every((row, index) => quote.selectedSeats[index] === row.seat) &&
      quote.targetKey === cancellationTargetKey(quote.ticket, quote.orderNumber, quote.selected) &&
      normalizedPayload(quote.payload) === normalizedPayload(cancellationMutationBody(quote))
    );
  }, "Cancellation snapshot is inconsistent")
  .readonly();
export type GoCancellationQuote = z.infer<typeof GoCancellationQuoteSchema>;
export type GoCancellationOutcome =
  | { readonly status: "unknown" }
  | {
      readonly status: "confirmed";
      readonly feeKrw: number;
      readonly refundKrw: number;
      readonly cancelledAt: string;
    };
