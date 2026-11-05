import { GoBusError } from "./go-bus-types";
import {
  cancellationIdentity,
  hashTicket,
  historyKey,
  matchesTicketOrder,
  nativeTicket,
  sameTrip,
} from "./go-ticket-native";
import type { GoTicketReads } from "./go-ticket-reads";
import {
  type GoCancellationOutcome,
  type GoCancellationQuote,
  type GoTicketAccount,
  ticketBelongsToAccount,
} from "./go-ticket-types";

export async function reconcileCancellation(
  reads: GoTicketReads,
  account: GoTicketAccount,
  quote: GoCancellationQuote,
): Promise<GoCancellationOutcome> {
  if (!ticketBelongsToAccount(quote.ticket, account)) return { status: "unknown" };
  try {
    const history = await reads.history(account, quote.ticket.service);
    if (
      !quote.remaining.length &&
      history.some((row) => row.BMG_COD === "1" && sameTrip(row, quote.ticket))
    )
      return { status: "unknown" };
    const events = history.filter(
      (row) =>
        row.BMG_COD === "4" &&
        sameTrip(row, quote.ticket) &&
        !quote.historyBaseline.includes(historyKey(row, quote.ticket.service)),
    );
    if (
      events.length !== 1 ||
      !events[0] ||
      (events[0].ORD_SNO !== undefined && events[0].ORD_SNO !== quote.orderNumber) ||
      events[0].CNT !== quote.selectedSeats.length
    )
      return { status: "unknown" };
    const receipt = await reads.receipt(account, events[0], quote.ticket.service);
    if (
      !sameTrip(receipt, quote.ticket) ||
      receipt.ORD_SNO !== quote.orderNumber ||
      receipt.ADM_KND_COD !== "N" ||
      (receipt.BMG_COD !== undefined && receipt.BMG_COD !== "4") ||
      (receipt.SORT_DTE !== undefined && receipt.SORT_DTE !== events[0].SORT_DTE) ||
      receipt.PEP_CHA === undefined ||
      receipt.CAN_FEE === undefined ||
      !/^\d{8}$/.test(receipt.CAN_DTE ?? "") ||
      !/^(?:[01]\d|2[0-3])[0-5]\d(?:[0-5]\d)?$/.test(receipt.CAN_TIM ?? "") ||
      !/^\d{1,2}(?:,\d{1,2})*$/.test(receipt.SET_NO ?? "")
    )
      return { status: "unknown" };
    const seats = receipt.SET_NO?.split(",").map(Number) ?? [];
    if (
      seats.length !== quote.selectedSeats.length ||
      new Set(seats).size !== seats.length ||
      seats.some((seat) => !quote.selectedSeats.includes(seat))
    )
      return { status: "unknown" };
    const date = receipt.CAN_DTE ?? "";
    const time = receipt.CAN_TIM ?? "";
    const calendarDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
    const seconds = time.length === 6 ? `:${time.slice(4, 6)}` : "";
    const cancelledAt = `${calendarDate}T${time.slice(0, 2)}:${time.slice(2, 4)}${seconds}+09:00`;
    const cancelledAtMs = Date.parse(cancelledAt);
    const precisionMs = time.length === 4 ? 60_000 : 1000;
    if (
      !Number.isFinite(cancelledAtMs) ||
      new Date(cancelledAtMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10) !== calendarDate ||
      cancelledAtMs < Math.floor(quote.quotedAt / precisionMs) * precisionMs
    )
      return { status: "unknown" };
    if (quote.remaining.length) {
      const active = history.filter((row) => row.BMG_COD === "1" && sameTrip(row, quote.ticket));
      if (active.length !== 1 || active[0]?.CNT !== quote.remaining.length)
        return { status: "unknown" };
      const tickets = (await reads.tickets(account, quote.ticket)).map(nativeTicket);
      if (
        tickets.length !== quote.remaining.length ||
        tickets.some(
          (row) =>
            !sameTrip(row, quote.ticket) ||
            !matchesTicketOrder(row, quote.orderNumber, quote.ticket.service) ||
            !quote.remaining.some(
              (remaining) =>
                remaining.seat === Number(row.SET_NO) && remaining.issuanceId === row.TISU_ID,
            ),
        )
      )
        return { status: "unknown" };
      const remaining = (await reads.candidates(account, quote.ticket)).map((raw) =>
        cancellationIdentity(raw, quote.ticket, quote.orderNumber),
      );
      if (
        remaining.length !== quote.remaining.length ||
        remaining.some(
          (row) => !quote.remaining.some((original) => hashTicket(original) === hashTicket(row)),
        )
      )
        return { status: "unknown" };
    }
    return {
      status: "confirmed",
      feeKrw: receipt.PEP_CHA,
      refundKrw: receipt.CAN_FEE,
      cancelledAt,
    };
  } catch (error) {
    if (error instanceof GoBusError && error.code !== "authentication_required")
      return { status: "unknown" };
    throw error;
  }
}
