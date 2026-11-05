import { z } from "zod";
import { goHeldSeats, goSeatFare } from "./go-bus-fares";
import type { GoBusHttp } from "./go-bus-http";
import { type GoBusContext, GoBusError, goBusAliases } from "./go-bus-types";
import type { GoPurchaseHttp } from "./go-purchase-http";
import {
  buildGoIssueBody,
  GoPurchaseError,
  type GoPurchaseLookup,
  type GoPurchaseOutcome,
} from "./go-purchase-types";
import { GoResponseAmountSchema } from "./go-response-values";
import { nativeRows, nativeTicket, supportedTicket } from "./go-ticket-native";

const text = z.string().min(1).max(16384);
const orderAliases = {
  orderNumber: ["ordSno", "ORD_SNO", "ord_sno"],
  ticketNumber: ["linSno", "LIN_SNO", "lin_sno"],
} as const;
const ticketIdentitySchema = z.object({
  LIN_SNO: text,
  USR_SNO: text,
  TIM_DTE: text,
  TIM_TIM: text,
  TER_SFR: text,
  TER_STO: text,
});
const ticketDetailSchema = ticketIdentitySchema.extend({
  ORD_SNO: text,
  ADM_AMT: GoResponseAmountSchema,
  SET_NO: z.string().regex(/^\d{1,2}(?:,\d{1,2})*$/),
});
const ticketListRowSchema = ticketIdentitySchema.extend({
  ORD_SNO: text.optional(),
  SET_NO: z.string().regex(/^\d{1,2}$/),
  TCK_FEE: GoResponseAmountSchema,
  TISU_ID: text,
  BTK_COD: z.string().optional(),
});
const historySchema = z.object({
  rstCd: z.union([z.literal("200"), z.literal(200)]),
  dta: z.object({
    busUtlzList: z.array(
      z.object({
        LIN_SNO: text,
        USR_SNO: text,
        TIM_DTE: text,
        TIM_TIM: text,
        BMG_COD: text,
        CNT: z.number().int().nonnegative(),
      }),
    ),
  }),
});

export class GoPurchaseReconciler {
  readonly #bus: GoBusHttp;
  readonly #account: GoPurchaseHttp;

  constructor(bus: GoBusHttp, account: GoPurchaseHttp) {
    this.#bus = bus;
    this.#account = account;
  }

  async reconcile(context: GoBusContext, lookup: GoPurchaseLookup): Promise<GoPurchaseOutcome> {
    const { hold } = lookup;
    if (
      !/^\d{4}(?:0[1-9]|1[0-2])$/.test(lookup.purchaseMonth) ||
      !text.safeParse(lookup.memberSerialNumber).success
    ) {
      throw new GoPurchaseError("configuration");
    }
    const body = buildGoIssueBody(hold);
    const heldSeats = goHeldSeats(hold);
    const totalFare = Number(body.TOT_AMT);
    try {
      let reference: { readonly ticketNumber: string; readonly orderNumber?: string };
      try {
        const raw = await this.#bus.post(context, {
          path: "ticket/selectTckRstStat.do",
          body: {
            TIM_DTE: body.TIM_DTE,
            TIM_TIM: body.TIM_TIM,
            TER_SFR: body.TER_SFR,
            TER_STO: body.TER_STO,
            SET_NO: body.SET_NO_WEB,
            ADM_KND_COD: "N",
          },
        });
        const result = z
          .object({ orderNumber: text, ticketNumber: text })
          .safeParse(goBusAliases(raw, orderAliases));
        if (!result.success) return { status: "unknown" };
        reference = result.data;
      } catch (error) {
        if (!(error instanceof GoBusError) || error.code !== "rejected") throw error;
        const raw = await this.#bus.post(context, {
          path: "user/selectMyPagePayList.do",
          body: { BMG_COD: "0" },
        });
        const candidates = nativeRows(raw, "payList")
          .map(nativeTicket)
          .filter(
            (entry) =>
              entry.BMG_COD === "1" &&
              supportedTicket(entry) &&
              entry.TIM_DTE === body.TIM_DTE &&
              entry.TIM_TIM.padEnd(6, "0") === body.TIM_TIM.padEnd(6, "0") &&
              entry.TER_SFR === body.TER_SFR &&
              entry.TER_STO === body.TER_STO &&
              entry.CNT === heldSeats.length,
          );
        const candidate = candidates[0];
        if (candidates.length !== 1 || !candidate) return { status: "unknown" };
        reference = {
          ticketNumber: candidate.LIN_SNO,
          ...(candidate.ORD_SNO === undefined ? {} : { orderNumber: candidate.ORD_SNO }),
        };
      }
      const detailRequest = {
        MEM_SNO: lookup.memberSerialNumber,
        LIN_SNO: reference.ticketNumber,
      };
      const detailRaw = await this.#bus.post(context, {
        path: "ticket/selectBuyTckInfo2.do",
        body: detailRequest,
      });
      const detail = ticketDetailSchema.safeParse(detailRaw);
      if (!detail.success) return { status: "unknown" };
      const matches = (ticket: z.infer<typeof ticketIdentitySchema>) =>
        ticket.LIN_SNO === reference.ticketNumber &&
        ticket.TIM_DTE === body.TIM_DTE &&
        ticket.TIM_TIM.padEnd(6, "0") === body.TIM_TIM.padEnd(6, "0") &&
        ticket.TER_SFR === body.TER_SFR &&
        ticket.TER_STO === body.TER_STO;
      const detailSeats = detail.data.SET_NO.split(",").map((seat) => seat.padStart(2, "0"));
      if (
        !matches(detail.data) ||
        (reference.orderNumber !== undefined && detail.data.ORD_SNO !== reference.orderNumber) ||
        detail.data.ADM_AMT !== totalFare ||
        detailSeats.length !== heldSeats.length ||
        new Set(detailSeats).size !== heldSeats.length ||
        heldSeats.some((seat) => !detailSeats.includes(seat.seat))
      )
        return { status: "unknown" };
      const listRaw = await this.#bus.post(context, {
        path: "ticket/selectBuyTckInfoList2.do",
        body: detailRequest,
      });
      const list = z
        .object({ tckList: z.array(ticketListRowSchema).length(heldSeats.length) })
        .safeParse(goBusAliases(listRaw, { tckList: ["TCK_LIST"] }));
      if (!list.success) return { status: "unknown" };
      const tickets = list.data.tckList;
      if (
        new Set(tickets.map((ticket) => ticket.SET_NO.padStart(2, "0"))).size !==
          heldSeats.length ||
        new Set(tickets.map((ticket) => ticket.TISU_ID)).size !== heldSeats.length
      )
        return { status: "unknown" };
      for (const seat of heldSeats) {
        const ticket = tickets.find((ticket) => ticket.SET_NO.padStart(2, "0") === seat.seat);
        if (
          !ticket ||
          !matches(ticket) ||
          (ticket.ORD_SNO !== undefined && ticket.ORD_SNO !== detail.data.ORD_SNO) ||
          ticket.TCK_FEE !== goSeatFare(hold.info, seat.ticketKind) ||
          ("seats" in hold && ticket.BTK_COD !== seat.ticketKind)
        )
          return { status: "unknown" };
      }
      const year = Number(lookup.purchaseMonth.slice(0, 4));
      const month = Number(lookup.purchaseMonth.slice(4));
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const historyRaw = await this.#account.post(context, "api/mbrs/v2/inqrMbrsBusUtlzList", {
        inqrCtVal: "T",
        rideStatCd: "0",
        inqrSttDt: `${lookup.purchaseMonth}01`,
        inqrEndDt: `${lookup.purchaseMonth}${lastDay}`,
        jrnyYn: "N",
        inqrMonth: lookup.purchaseMonth,
      });
      const history = historySchema.safeParse(historyRaw);
      if (!history.success) return { status: "unknown" };
      const sameTickets = history.data.dta.busUtlzList.filter(
        (entry) => entry.LIN_SNO === reference.ticketNumber,
      );
      const active = sameTickets.length === 1 ? sameTickets[0] : undefined;
      if (
        active?.BMG_COD !== "1" ||
        active.CNT !== heldSeats.length ||
        active.TIM_DTE !== body.TIM_DTE ||
        active.TIM_TIM.padEnd(6, "0") !== body.TIM_TIM.padEnd(6, "0")
      )
        return { status: "unknown" };
      return {
        status: "confirmed",
        orderNumber: detail.data.ORD_SNO,
        ticketNumber: reference.ticketNumber,
        seat: body.SET_NO_WEB,
        fareKrw: totalFare,
        ...("seats" in hold
          ? {
              tickets: tickets.map((ticket) => ({
                ticketNumber: ticket.TISU_ID,
                seat: ticket.SET_NO.padStart(2, "0"),
                fareKrw: Number(ticket.TCK_FEE),
              })),
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof GoBusError || error instanceof GoPurchaseError)
        return { status: "unknown" };
      throw error;
    }
  }
}
