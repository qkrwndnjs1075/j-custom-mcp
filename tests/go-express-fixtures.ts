import { TmoneyGoBusClient } from "../src/go-bus";
import type { GoBusHold } from "../src/go-bus-types";
import { GoExpressTripSchema } from "../src/go-express-types";
import { TmoneyGoPurchaseClient } from "../src/go-purchase";
import { context } from "./go-passenger-fixtures";

export { context };
export const secret = "synthetic-express-private";
export const trip = GoExpressTripSchema.parse({
  service: "express",
  row: {
    timdte: "20261030",
    timtim: "1420",
    timtimo: "1400",
    terfri: "021",
    tertoi: "393",
    terfro: "020",
    tertoo: "394",
    busgrao: "1",
    corcodo: "53",
    adltfee: 15000,
    webcnt: "28",
    lintim: "0130",
    linend1: "120",
    tckpay: "Y",
  },
  expectedAdultFareKrw: 15000,
  expectedTotalFareKrw: 34500,
  passengers: { adults: 1, students: 1, children: 1 },
  fareQuotes: {
    adults: { unitFareKrw: 15000, fareKindCode: "1" },
    students: { unitFareKrw: 12000, fareKindCode: "9" },
    children: { unitFareKrw: 7500, fareKindCode: "2" },
  },
  departureTerminal: { TER_COD: "021", ARPR_TRML_YN: "N" },
  arrivalTerminal: { TER_COD: "393", ARPR_TRML_YN: "N" },
});
export const info = {
  tckfee1: "15000",
  tckfee2: "7500",
  tckfee9: "12000",
  totcnt: "28",
  seatlist: [{ "01": "Y", "02": "N", "03": "Y", "04": "Y" }],
};
export const hold = {
  trip,
  info,
  seats: [
    { seat: "01", holdId: "express-h1", ticketKind: "2", passengerType: "child" },
    { seat: "03", holdId: "express-h3", ticketKind: "1", passengerType: "adult" },
    { seat: "04", holdId: "express-h4", ticketKind: "9", passengerType: "student" },
  ],
} as const satisfies GoBusHold;
export const selection = [
  { seat: 4, passengerType: "student" },
  { seat: 1, passengerType: "child" },
  { seat: 3, passengerType: "adult" },
] as const;
export const seatResponse = {
  errCode: "00000",
  tot_cnt: "28",
  seat_list: info.seatlist,
  fee_list: [
    { tck_knd_cd: "1", dc_knd_cd: "0", fee: "15000" },
    { tck_knd_cd: "2", dc_knd_cd: "0", fee: "7500" },
    { tck_knd_cd: "9", dc_knd_cd: "0", fee: "12000" },
    { tck_knd_cd: "1", dc_knd_cd: "a", fee: "10000" },
  ],
};
export const holdResponse = {
  errCode: "00000",
  pcpy_list: hold.seats.map((seat) => ({ set_no: seat.seat, pcpy_no: seat.holdId })),
};
export const identity = {
  ORD_SNO: "express-order",
  LIN_SNO: "express-line",
  USR_SNO: context.userNumber,
  TIM_DTE: trip.row.timdte,
  TIM_TIM: trip.row.timtim,
  TER_SFR: "021",
  TER_STO: "393",
  TER_FR: trip.row.terfro,
  TER_TO: trip.row.tertoo,
  COR_COD: trip.row.corcodo,
  BD_COD: trip.row.busgrao,
  TIM_TIM_I: trip.row.timtimo,
};
export const tickets = hold.seats.map((seat) => ({
  ...identity,
  SET_NO: seat.seat,
  TCK_KND_COD: seat.ticketKind,
  TCK_FEE: { "1": "15000", "2": "7500", "9": "12000" }[seat.ticketKind],
  TISU_ID: `ticket-${seat.seat}`,
}));
export const lookup = {
  hold,
  memberSerialNumber: "express-member",
  purchaseMonth: "202610",
  receiptBaseline: [],
};
export function response(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path.endsWith("selectTimInfo2.do"))
    return Response.json({ errCode: "00000", line_list: [trip.row] });
  if (path.endsWith("selectArrInfo.do")) return Response.json(seatResponse);
  if (path.endsWith("insertPcpyNo.do")) return Response.json(holdResponse);
  if (path.endsWith("inqrPymMnsListAtPym"))
    return Response.json({
      rstCd: "200",
      dta: {
        npayautPymInfo: { cardCpNm: "Synthetic", cardNum4th: "0000", automaticPayId: secret },
      },
    });
  if (path.endsWith("autoReserve"))
    return Response.json({
      rstCd: "200",
      dta: { rspCd: "0000", oderSno: "payment-order", authDataCard: secret, authDataAuth: secret },
    });
  if (path.endsWith("selectTckRstStat.do"))
    return Response.json({
      errCode: "00000",
      lin_sno: identity.LIN_SNO,
      ord_sno: identity.ORD_SNO,
    });
  if (path.endsWith("selectBuyTckInfo2.do"))
    return Response.json({
      errCode: "00000",
      ...identity,
      BMG_COD: "1",
      SET_NO: "1,3,4",
      ADM_AMT: "34500",
    });
  if (path.endsWith("selectBuyTckInfoList2.do"))
    return Response.json({ errCode: "00000", tckList: tickets });
  if (path.endsWith("selectBuyTckListSecu.do"))
    return Response.json({
      errCode: "00000",
      ticketList: [
        {
          linSno: identity.LIN_SNO,
          usrSno: context.userNumber,
          timDte: trip.row.timdte,
          timTim: trip.row.timtim,
          terSfr: "021",
          terSto: "393",
          cnt: "3",
        },
      ],
    });
  return Response.json({ errCode: "00000" });
}
const servers: ReturnType<typeof Bun.serve>[] = [];
export function stopFixtures() {
  for (const server of servers.splice(0)) server.stop(true);
}
export function fixture(handler = response) {
  const requests: Request[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  return {
    requests,
    bus: new TmoneyGoBusClient({ fetch: transport }),
    purchase: new TmoneyGoPurchaseClient({ fetch: transport }),
  };
}
