import { z } from "zod";
import { goHeldSeats, goSeatFare } from "./go-bus-fares";
import type { GoBusHttp } from "./go-bus-http";
import { type GoBusContext, GoBusError, goBusAliases } from "./go-bus-types";
import { ReceiptBaselineSchema } from "./go-express-baseline";
import { buildGoExpressIssueBody } from "./go-express-issue";
import {
  GoPurchaseError,
  type GoPurchaseLookup,
  type GoPurchaseOutcome,
} from "./go-purchase-types";

const text = z.string().min(1).max(1024);
const identity = z.object({
  ORD_SNO: text,
  LIN_SNO: text,
  USR_SNO: text,
  TIM_DTE: text,
  TIM_TIM: text,
  TER_SFR: text,
  TER_STO: text,
  TER_FR: text,
  TER_TO: text,
  COR_COD: text,
  BD_COD: text,
  TIM_TIM_I: text,
});
const detailSchema = identity.extend({
  ADM_AMT: z.string().regex(/^\d+$/),
  SET_NO: z.string().regex(/^\d{1,2}(?:,\d{1,2})*$/),
  BMG_COD: z.literal("1"),
});
const ticketSchema = identity.extend({
  SET_NO: z.string().regex(/^\d{1,2}$/),
  TCK_FEE: z.string().regex(/^\d+$/),
  TCK_KND_COD: z.enum(["1", "2", "9"]),
  TISU_ID: text,
});
const activeSchema = z.object({
  linSno: text,
  usrSno: text,
  timDte: text,
  timTim: text,
  terSfr: text,
  terSto: text,
  cnt: z.string().regex(/^\d+$/),
});
const activeAliases = {
  linSno: ["lin_sno", "LIN_SNO"],
  usrSno: ["usr_sno", "USR_SNO"],
  timDte: ["tim_dte", "TIM_DTE"],
  timTim: ["tim_tim", "TIM_TIM"],
  terSfr: ["ter_sfr", "TER_SFR"],
  terSto: ["ter_sto", "TER_STO"],
  cnt: ["CNT"],
} as const;

export class GoExpressReconciler {
  constructor(readonly http: GoBusHttp) {}

  async reconcile(context: GoBusContext, lookup: GoPurchaseLookup): Promise<GoPurchaseOutcome> {
    if (
      !text.safeParse(lookup.memberSerialNumber).success ||
      !/^\d{4}(?:0[1-9]|1[0-2])$/.test(lookup.purchaseMonth)
    )
      throw new GoPurchaseError("configuration");
    const baseline = ReceiptBaselineSchema.safeParse(lookup.receiptBaseline);
    if (!baseline.success) return { status: "unknown" };
    const body = buildGoExpressIssueBody(lookup.hold);
    const seats = goHeldSeats(lookup.hold);
    try {
      const raw = await this.http.post(context, {
        service: "express",
        path: "ticket/selectTckRstStat.do",
        body: {
          tim_dte: body.tim_dte,
          tim_tim_i: body.tim_tim_i,
          ter_sfr: body.ter_sfr,
          ter_sto: body.ter_sto,
          set_no: body.set_no_web,
          adm_knd_cod: body.adm_knd_cod,
        },
      });
      const result = z.object({ order: text, line: text }).safeParse(
        goBusAliases(raw, {
          order: ["ordSno", "ord_sno", "ORD_SNO"],
          line: ["linSno", "lin_sno", "LIN_SNO"],
        }),
      );
      if (!result.success || baseline.data.includes(result.data.line)) return { status: "unknown" };
      const request = { mem_sno: lookup.memberSerialNumber, lin_sno: result.data.line };
      const detail = detailSchema.safeParse(
        await this.http.post(context, {
          service: "express",
          path: "ticket/selectBuyTckInfo2.do",
          body: request,
        }),
      );
      if (!detail.success) return { status: "unknown" };
      const matches = (ticket: z.infer<typeof identity>) =>
        ticket.ORD_SNO === result.data.order &&
        ticket.LIN_SNO === result.data.line &&
        ticket.USR_SNO === context.userNumber &&
        ticket.TIM_DTE === body.tim_dte &&
        ticket.TIM_TIM.padEnd(6, "0") === body.tim_tim.padEnd(6, "0") &&
        ticket.TER_SFR === body.ter_sfr &&
        ticket.TER_STO === body.ter_sto &&
        ticket.TER_FR === body.ter_fr &&
        ticket.TER_TO === body.ter_to &&
        ticket.COR_COD === body.cor_cod &&
        ticket.BD_COD === body.bus_gra &&
        ticket.TIM_TIM_I.padEnd(6, "0") === body.tim_tim_i.padEnd(6, "0");
      const detailSeats = detail.data.SET_NO.split(",").map((seat) => seat.padStart(2, "0"));
      if (
        !matches(detail.data) ||
        Number(detail.data.ADM_AMT) !== Number(body.tot_amt) ||
        detailSeats.length !== seats.length ||
        new Set(detailSeats).size !== seats.length ||
        seats.some((seat) => !detailSeats.includes(seat.seat))
      )
        return { status: "unknown" };
      const listRaw = await this.http.post(context, {
        service: "express",
        path: "ticket/selectBuyTckInfoList2.do",
        body: request,
      });
      const list = z
        .object({ tckList: z.array(ticketSchema).length(seats.length) })
        .safeParse(goBusAliases(listRaw, { tckList: ["TCK_LIST"] }));
      if (!list.success) return { status: "unknown" };
      const tickets = list.data.tckList;
      if (
        new Set(tickets.map((ticket) => ticket.SET_NO.padStart(2, "0"))).size !== seats.length ||
        new Set(tickets.map((ticket) => ticket.TISU_ID)).size !== seats.length
      )
        return { status: "unknown" };
      for (const seat of seats) {
        const ticket = tickets.find((ticket) => ticket.SET_NO.padStart(2, "0") === seat.seat);
        if (
          !ticket ||
          !matches(ticket) ||
          ticket.TCK_KND_COD !== seat.ticketKind ||
          Number(ticket.TCK_FEE) !== goSeatFare(lookup.hold.info, seat.ticketKind)
        )
          return { status: "unknown" };
      }
      const activeRaw = await this.http.post(context, {
        service: "express",
        path: "ticket/selectBuyTckListSecu.do",
        body: {
          mem_sno: lookup.memberSerialNumber,
          hp_syn_yn: "N",
          arpr_trml_yn: "N",
        },
      });
      const activeList = z
        .object({ ticketList: z.array(z.unknown()) })
        .safeParse(goBusAliases(activeRaw, { ticketList: ["ticket_list", "TICKET_LIST"] }));
      if (!activeList.success) return { status: "unknown" };
      const active = activeList.data.ticketList.map((item) =>
        activeSchema.safeParse(goBusAliases(item, activeAliases)),
      );
      const matched = active.filter(
        (item) => item.success && item.data.linSno === result.data.line,
      );
      const entry = matched[0];
      if (
        matched.length !== 1 ||
        !entry?.success ||
        entry.data.usrSno !== context.userNumber ||
        entry.data.timDte !== body.tim_dte ||
        entry.data.timTim.padEnd(6, "0") !== body.tim_tim.padEnd(6, "0") ||
        entry.data.terSfr !== body.ter_sfr ||
        entry.data.terSto !== body.ter_sto ||
        Number(entry.data.cnt) !== seats.length
      )
        return { status: "unknown" };
      return {
        status: "confirmed",
        orderNumber: result.data.order,
        ticketNumber: result.data.line,
        seat: body.set_no_web,
        fareKrw: Number(body.tot_amt),
        tickets: tickets.map((ticket) => ({
          ticketNumber: ticket.TISU_ID,
          seat: ticket.SET_NO.padStart(2, "0"),
          fareKrw: Number(ticket.TCK_FEE),
        })),
      };
    } catch (error) {
      if (error instanceof GoBusError || error instanceof GoPurchaseError)
        return { status: "unknown" };
      throw error;
    }
  }
}
