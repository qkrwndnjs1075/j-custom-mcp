import { z } from "zod";
import { GoBusHttp } from "./go-bus-http";
import { GoBusError, goBusAliases, parseGoBusValue } from "./go-bus-types";
import { cancellationFeeBody, cancellationMutationBody } from "./go-cancel-payload";
import { reconcileCancellation } from "./go-cancel-reconcile";
import {
  cancellationIdentity,
  feeResult,
  historyKey,
  matchesTicketOrder,
  nativeTicket,
  sameTrip,
  supportedTicket,
} from "./go-ticket-native";
import { GoTicketReads } from "./go-ticket-reads";
import {
  cancellationTargetKey,
  type GoCancellationOutcome,
  type GoCancellationQuote,
  GoCancellationQuoteSchema,
  type GoCancellationSelection,
  GoCancellationSelectionSchema,
  type GoTicket,
  type GoTicketAccount,
  GoTicketSchema,
  ticketBelongsToAccount,
} from "./go-ticket-types";

export class TmoneyGoTicketClient {
  readonly #reads: GoTicketReads;
  readonly #now: () => number;
  constructor(options: { readonly http?: GoBusHttp; readonly now?: () => number } = {}) {
    this.#reads = new GoTicketReads(options.http ?? new GoBusHttp());
    this.#now = options.now ?? Date.now;
  }
  async list(account: GoTicketAccount, service: GoTicket["service"]): Promise<readonly GoTicket[]> {
    const rows = await this.#reads.history(account, service);
    return rows
      .filter((row) => row.BMG_COD === "1" && supportedTicket(row))
      .map((row) =>
        parseGoBusValue(GoTicketSchema, {
          service,
          lineNumber: row.LIN_SNO,
          sortDate: row.SORT_DTE,
          ownerUserNumber: row.USR_SNO,
          accountBinding: account.bindingHash,
          departureDate: row.TIM_DTE,
          departureTime: row.TIM_TIM.padEnd(6, "0"),
          departureId: row.TER_SFR,
          arrivalId: row.TER_STO,
          departureName: row.FR_NAM,
          arrivalName: row.TO_NAM,
          paymentCode: row.ADM_KND_COD,
          statusCode: row.BMG_COD,
          count: row.CNT,
        }),
      );
  }
  async quote(
    account: GoTicketAccount,
    input: GoCancellationSelection,
  ): Promise<GoCancellationQuote> {
    const parsed = GoCancellationSelectionSchema.safeParse(input);
    if (!parsed.success || !ticketBelongsToAccount(parsed.data.ticket, account))
      throw new GoBusError("input");
    const { ticket, selection } = parsed.data;
    const history = await this.#reads.history(account, ticket.service);
    const active = history.filter(
      (row) => sameTrip(row, ticket) && row.BMG_COD === "1" && row.SORT_DTE === ticket.sortDate,
    );
    if (
      active.length !== 1 ||
      !active[0] ||
      !supportedTicket(active[0]) ||
      active[0].CNT !== ticket.count
    )
      throw new GoBusError("trip_match");
    const detail = await this.#reads.detail(account, ticket);
    if (
      !sameTrip(detail, ticket) ||
      !supportedTicket(detail) ||
      !detail.ORD_SNO ||
      detail.CNT !== ticket.count
    )
      throw new GoBusError("trip_match");
    const orderNumber = detail.ORD_SNO;
    const rawTickets = await this.#reads.tickets(account, ticket);
    const tickets = rawTickets.map(nativeTicket);
    if (
      tickets.length !== ticket.count ||
      tickets.some(
        (row) =>
          !sameTrip(row, ticket) ||
          !matchesTicketOrder(row, orderNumber, ticket.service) ||
          row.DSC_TCK === "Y" ||
          row.DCT_COD === "4" ||
          row.DCT_COD === "5",
      )
    )
      throw new GoBusError("trip_match");
    const candidateRaw = await this.#reads.candidates(account, ticket);
    const candidates = candidateRaw.map((raw) => cancellationIdentity(raw, ticket, orderNumber));
    if (
      candidates.length !== ticket.count ||
      new Set(candidates.map((row) => row.seat)).size !== ticket.count
    )
      throw new GoBusError("response");
    if (
      tickets.some(
        (row) =>
          !row.TISU_ID ||
          !candidates.some(
            (candidate) =>
              candidate.seat === Number(row.SET_NO) && candidate.issuanceId === row.TISU_ID,
          ),
      )
    )
      throw new GoBusError("trip_match");
    if (new Set(candidates.map((row) => row.issuanceId)).size !== candidates.length)
      throw new GoBusError("response");
    if (new Set(tickets.map((row) => row.SET_NO)).size !== tickets.length)
      throw new GoBusError("response");
    const chosen = (() => {
      switch (selection.mode) {
        case "all":
          return candidates.map((row) => row.seat);
        case "seats":
          return selection.seats;
      }
    })();
    const selected = candidates
      .filter((row) => chosen.includes(row.seat))
      .sort((a, b) => a.seat - b.seat);
    if (selected.length !== chosen.length) throw new GoBusError("input");
    const remaining = candidates
      .filter((row) => !chosen.includes(row.seat))
      .sort((a, b) => a.seat - b.seat);
    const base = {
      ticket,
      selected,
      remaining,
      orderNumber: detail.ORD_SNO,
      publicationDivision: detail.TCK_PUB_DIV_COD ?? "",
      quotedAt: this.#now(),
    };
    if (ticket.service === "intercity" && !base.publicationDivision)
      throw new GoBusError("response");
    const fee = feeResult(
      await this.#reads.http.post(account.context, {
        service: ticket.service,
        path: "ticket/selectFeeInfo.do",
        body: cancellationFeeBody(base),
      }),
    );
    const refundKrw = ticket.service === "express" ? fee.tckFee - fee.canFee : fee.tckFee;
    return parseGoBusValue(GoCancellationQuoteSchema, {
      ...base,
      publicationDivision: base.publicationDivision || "none",
      selectedSeats: selected.map((row) => row.seat),
      feeKrw: fee.canFee,
      refundKrw,
      targetKey: cancellationTargetKey(ticket, detail.ORD_SNO, selected),
      historyBaseline: history
        .filter((row) => row.BMG_COD === "4")
        .map((row) => historyKey(row, ticket.service)),
      payload: cancellationMutationBody(base),
    });
  }
  async cancel(
    account: GoTicketAccount,
    quote: GoCancellationQuote,
  ): Promise<{ readonly acknowledged: boolean }> {
    if (!ticketBelongsToAccount(quote.ticket, account)) throw new GoBusError("input");
    const response = await this.#reads.http.post(account.context, {
      service: quote.ticket.service,
      path: "ticket/insertTckCanCad2.do",
      body: cancellationMutationBody(quote),
      mutation: "cancellation",
    });
    try {
      const ack = parseGoBusValue(
        z.object({ date: z.string().min(1) }),
        goBusAliases(response, { date: ["CAN_REG_DTE", "canRegDte", "can_reg_dte"] }),
      );
      const body =
        quote.ticket.service === "express"
          ? { ord_sno: quote.orderNumber, job_div: "2", canRegDte: ack.date }
          : { ORD_SNO: quote.orderNumber, JOB_DIV: "2", CAN_REG_DTE: ack.date };
      await this.#reads.http.post(account.context, {
        service: quote.ticket.service,
        path: "ticket/tckResponse.do",
        body,
        mutation: "acknowledgement",
      });
      return { acknowledged: true };
    } catch (error) {
      if (error instanceof GoBusError) return { acknowledged: false };
      throw error;
    }
  }
  async reconcile(
    account: GoTicketAccount,
    quote: GoCancellationQuote,
  ): Promise<GoCancellationOutcome> {
    return reconcileCancellation(this.#reads, account, quote);
  }
}
