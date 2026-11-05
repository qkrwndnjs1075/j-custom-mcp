import { z } from "zod";
import type { GoBusHttp } from "./go-bus-http";
import { selectableGoSeats } from "./go-bus-seat-map";
import {
  type GoBusContext,
  GoBusError,
  GoBusSeatInfoSchema,
  type GoBusSeats,
  goBusAliases,
  goBusRowAliases,
  parseGoBusValue,
} from "./go-bus-types";
import { GoExpressRowSchema, type GoExpressTrip, GoExpressTripSchema } from "./go-express-types";
import type { ExpressTrip } from "./provider-types";

export async function findGoExpressTrip(
  http: GoBusHttp,
  context: GoBusContext,
  web: ExpressTrip,
): Promise<GoExpressTrip> {
  if (web.totalFareKrw === null) throw new GoBusError("fare_changed");
  const raw = await http.post(context, {
    service: "express",
    path: "ticket/selectTimInfo2.do",
    body: {
      tim_dte: web.departureDate,
      tim_tim_i: `${web.departureTime.slice(0, 2)}00`,
      ter_fr_i: web.departureId,
      ter_to_i: web.arrivalId,
      bus_gra_i: "9",
      cal_flg: "0",
      cnt_100: "1",
      job_div: "",
      req_rec_num: "99999",
      pop_yn: "N",
    },
  });
  const list = parseGoBusValue(
    z.object({ linelist: z.array(z.unknown()) }),
    goBusAliases(raw, { linelist: ["line_list", "LINE_LIST"] }),
  ).linelist;
  const rows = list.map((row) =>
    parseGoBusValue(GoExpressRowSchema, goBusAliases(row, goBusRowAliases)),
  );
  const matches = rows.filter(
    (row) =>
      row.terfri === web.departureId &&
      row.tertoi === web.arrivalId &&
      row.terfro === web.expressIdentity.allocationDepartureId &&
      row.tertoo === web.expressIdentity.allocationArrivalId &&
      row.timdte === web.departureDate &&
      row.timtim.padEnd(6, "0") === web.departureTime &&
      row.timtimo.padEnd(6, "0") === web.scheduledDepartureTime &&
      row.busgrao === web.busClassId &&
      row.corcodo === web.carrierId,
  );
  const row = matches[0];
  if (matches.length !== 1 || !row) throw new GoBusError("trip_match");
  if (web.passengers.adults > 0 && row.adltfee !== web.adultFareKrw)
    throw new GoBusError("fare_changed");
  return {
    service: "express",
    row,
    expectedAdultFareKrw: web.adultFareKrw,
    expectedTotalFareKrw: web.totalFareKrw,
    passengers: web.passengers,
    fareQuotes: web.fareQuotes,
    departureTerminal: { TER_COD: web.departureId, ARPR_TRML_YN: "N" },
    arrivalTerminal: { TER_COD: web.arrivalId, ARPR_TRML_YN: "N" },
  };
}

const seatsSchema = z.object({
  tot_cnt: z.string().regex(/^\d+$/),
  seat_list: z.array(z.record(z.string().regex(/^\d{1,2}$/), z.string())),
  fee_list: z.array(
    z.object({ tck_knd_cd: z.string(), dc_knd_cd: z.string(), fee: z.string().regex(/^\d+$/) }),
  ),
});
export async function readGoExpressSeats(
  http: GoBusHttp,
  context: GoBusContext,
  trip: GoExpressTrip,
): Promise<GoBusSeats> {
  const checked = GoExpressTripSchema.safeParse(trip);
  if (!checked.success) throw new GoBusError("input");
  const { row } = checked.data;
  const raw = await http.post(context, {
    service: "express",
    path: "ticket/selectArrInfo.do",
    body: {
      tim_dte: row.timdte,
      ter_fr: row.terfro,
      ter_to: row.tertoo,
      tim_tim: row.timtimo,
      ter_sfr: row.terfri,
      ter_sto: row.tertoi,
      tim_tim_i: row.timtim,
      bus_gra: row.busgrao,
      cor_cod: row.corcodo,
    },
  });
  const data = parseGoBusValue(seatsSchema, raw);
  const fees = new Map<string, string>();
  for (const fee of data.fee_list.filter((entry) => entry.dc_knd_cd === "0")) {
    if (fees.has(fee.tck_knd_cd)) throw new GoBusError("response");
    fees.set(fee.tck_knd_cd, fee.fee);
  }
  const info = parseGoBusValue(GoBusSeatInfoSchema, {
    totcnt: data.tot_cnt,
    seatlist: data.seat_list,
    tckfee1: fees.get("1") ?? "0",
    tckfee2: fees.get("2"),
    tckfee9: fees.get("9"),
  });
  for (const [category, kind] of [
    ["adults", "1"],
    ["children", "2"],
    ["students", "9"],
  ] as const) {
    if (trip.passengers[category] === 0) continue;
    const quote = trip.fareQuotes[category];
    const fee = fees.get(kind);
    if (!quote || fee === undefined || Number(fee) <= 0 || Number(fee) !== quote.unitFareKrw)
      throw new GoBusError("fare_changed");
  }
  return { trip: checked.data, info, selectableSeats: selectableGoSeats(info) };
}
