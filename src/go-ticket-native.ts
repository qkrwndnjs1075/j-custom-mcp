import { createHash } from "node:crypto";
import { z } from "zod";
import { GoBusError, goBusAliases, parseGoBusValue } from "./go-bus-types";
import { GoResponseAmountSchema } from "./go-response-values";
import { type GoTicket, type GoTicketIdentity, GoTicketIdentitySchema } from "./go-ticket-types";

const text = z.string().min(1).max(1024);
const optional = z.string().max(1024).optional();
const money = GoResponseAmountSchema;
export const nativeTicketSchema = z
  .object({
    LIN_SNO: text,
    USR_SNO: text,
    TIM_DTE: z.string().regex(/^\d{8}$/),
    TIM_TIM: z.string().regex(/^\d{4}(?:\d{2})?$/),
    TER_SFR: text,
    TER_STO: text,
    ORD_SNO: optional,
    SORT_DTE: optional,
    BMG_COD: optional,
    ADM_KND_COD: optional,
    FR_NAM: optional,
    TO_NAM: optional,
    CNT: z.union([money, z.number().int().nonnegative()]).optional(),
    SET_NO: optional,
    TISU_ID: optional,
    DSC_TCK: optional,
    DCT_COD: optional,
    TCK_PUB_DIV_COD: optional,
    TCK_SEQ: optional,
    ACT_DTE: optional,
    TCK_TER: optional,
    TCK_WIN: optional,
    PUB_DTE: optional,
    PUB_TER: optional,
    PUB_WIN: optional,
    PUB_SNO: optional,
    PEP_CHA: money.optional(),
    CAN_FEE: money.optional(),
    CAN_DTE: optional,
    CAN_TIM: optional,
  })
  .readonly();
export type NativeTicket = z.infer<typeof nativeTicketSchema>;
export function nativeTicket(raw: unknown): NativeTicket {
  return parseGoBusValue(nativeTicketSchema, raw);
}
export function nativeRows(
  raw: unknown,
  field: "payList" | "tckList" | "ticketList",
): readonly unknown[] {
  const aliases = {
    payList: ["pay_list", "PAY_LIST"],
    tckList: ["TCK_LIST"],
    ticketList: ["ticket_list", "TICKET_LIST"],
    cmplYn: ["cmpl_yn", "CMPL_YN"],
  };
  const row = goBusAliases(raw, aliases);
  if (typeof row["cmplYn"] === "string" && row["cmplYn"].toUpperCase() === "Y")
    throw new GoBusError("input");
  return parseGoBusValue(z.array(z.unknown()), row[field]);
}
export function sameTrip(row: NativeTicket, ticket: GoTicket): boolean {
  return (
    row.LIN_SNO === ticket.lineNumber &&
    (ticket.service === "intercity" || row.USR_SNO === ticket.ownerUserNumber) &&
    row.TIM_DTE === ticket.departureDate &&
    row.TIM_TIM.padEnd(6, "0") === ticket.departureTime &&
    row.TER_SFR === ticket.departureId &&
    row.TER_STO === ticket.arrivalId
  );
}
export function hashTicket(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function historyKey(row: NativeTicket, service: GoTicket["service"]): string {
  return hashTicket([
    row.LIN_SNO,
    ...(service === "express" ? [row.USR_SNO] : []),
    row.SORT_DTE,
    row.BMG_COD,
    row.ORD_SNO,
    row.TIM_DTE,
    row.TIM_TIM,
    row.TER_SFR,
    row.TER_STO,
    row.SET_NO,
  ]);
}
export function supportedTicket(row: NativeTicket): boolean {
  return (
    row.ADM_KND_COD === "N" && row.DSC_TCK !== "Y" && row.DCT_COD !== "4" && row.DCT_COD !== "5"
  );
}
export function matchesTicketOrder(
  row: NativeTicket,
  orderNumber: string,
  service: GoTicket["service"],
): boolean {
  return row.ORD_SNO === orderNumber || (service === "intercity" && row.ORD_SNO === undefined);
}
export function cancellationIdentity(
  raw: unknown,
  ticket: GoTicket,
  orderNumber: string,
): GoTicketIdentity {
  const row = parseGoBusValue(
    z.object({ USR_SNO: text, LIN_SNO: text, ORD_SNO: text, TER_SFR: text, TER_STO: text }),
    raw,
  );
  if (
    (ticket.service === "express" && row.USR_SNO !== ticket.ownerUserNumber) ||
    row.LIN_SNO !== ticket.lineNumber ||
    row.ORD_SNO !== orderNumber ||
    row.TER_SFR !== ticket.departureId ||
    row.TER_STO !== ticket.arrivalId
  )
    throw new GoBusError("trip_match");
  return identity(raw, ticket.service);
}
export function identity(raw: unknown, service: GoTicket["service"]): GoTicketIdentity {
  const row = parseGoBusValue(z.record(z.string(), z.unknown()), raw);
  const values = parseGoBusValue(
    z.object({
      SET_NO: z.string().regex(/^\d{1,2}$/),
      TCK_SEQ:
        service === "intercity" ? text.nullish().transform((value) => value ?? "null") : text,
      TISU_ID: optional,
      ACT_DTE: optional,
      TCK_TER: optional,
      TCK_WIN: optional,
      PUB_DTE: optional,
      PUB_TER: optional,
      PUB_WIN: optional,
      PUB_SNO: optional,
    }),
    row,
  );
  if (
    service === "intercity" &&
    (!values.TISU_ID || !values.PUB_DTE || !values.PUB_TER || !values.PUB_WIN || !values.PUB_SNO)
  )
    throw new GoBusError("response");
  if (service === "express" && (!values.ACT_DTE || !values.TCK_TER || !values.TCK_WIN))
    throw new GoBusError("response");
  return parseGoBusValue(GoTicketIdentitySchema, {
    seat: Number(values.SET_NO),
    ticketSequence: values.TCK_SEQ,
    issuanceId: values.TISU_ID ?? "",
    actDate: values.ACT_DTE ?? "",
    ticketTerminal: values.TCK_TER ?? "",
    ticketWindow: values.TCK_WIN ?? "",
    publicationDate: values.PUB_DTE ?? "",
    publicationTerminal: values.PUB_TER ?? "",
    publicationWindow: values.PUB_WIN ?? "",
    publicationNumber: values.PUB_SNO ?? "",
  });
}
export function feeResult(raw: unknown) {
  return parseGoBusValue(
    z.object({ canFee: money, tckFee: money }),
    goBusAliases(raw, {
      canFee: ["CAN_FEE", "can_fee"],
      tckFee: ["TCK_FEE", "tck_fee"],
    }),
  );
}
export function serviceBody(service: GoTicket["service"], body: Readonly<Record<string, string>>) {
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      service === "express" ? key.toLowerCase() : key,
      value,
    ]),
  );
}
