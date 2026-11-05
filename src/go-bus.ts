import { z } from "zod";
import { holdGoSeats, releaseGoSeats } from "./go-bus-hold";
import { GoBusHttp } from "./go-bus-http";
import { selectableGoSeats } from "./go-bus-seat-map";
import { goBusTerminalCode, readGoBusTerminals, resolveGoBusTerminal } from "./go-bus-terminals";
import { GoBusTripSchema } from "./go-bus-trip-schema";
import type { GoPassengerType } from "./go-bus-types";
import {
  type GoBusContext,
  GoBusError,
  type GoBusHold,
  GoBusRowSchema,
  GoBusSeatInfoSchema,
  type GoBusSeats,
  type GoBusTrip,
  goBusAliases,
  goBusRowAliases,
  goBusSeatAliases,
  parseGoBusValue,
} from "./go-bus-types";
import { findGoExpressTrip, readGoExpressSeats } from "./go-express-bus";
import { type Trip, TripSchema } from "./provider-types";

export {
  type GoBusContext,
  GoBusError,
  type GoBusHold,
  type GoBusSeats,
  type GoBusTrip,
} from "./go-bus-types";

export class TmoneyGoBusClient {
  readonly #http: GoBusHttp;

  constructor(
    options: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number } = {},
  ) {
    this.#http = new GoBusHttp(options);
  }

  async lookupUser(context: GoBusContext, memberSerial: string): Promise<string> {
    const member = z.string().min(1).max(256).safeParse(memberSerial);
    if (!member.success) throw new GoBusError("input");
    const response = await this.#http.post(context, {
      path: "user/getUsrSno.do",
      body: { MEM_SNO: member.data },
    });
    return parseGoBusValue(z.object({ USR_SNO: z.string().min(1).max(1024) }), response).USR_SNO;
  }

  async findTrip(context: GoBusContext, trip: Trip): Promise<GoBusTrip> {
    const parsed = TripSchema.safeParse(trip);
    if (!parsed.success) throw new GoBusError("input");
    const web = parsed.data;
    switch (web.service) {
      case "express":
        return findGoExpressTrip(this.#http, context, web);
      case "intercity":
        break;
      default:
        return assertNever(web);
    }
    if (web.totalFareKrw === null) throw new GoBusError("fare_changed");
    const terminals = await readGoBusTerminals(this.#http, context);
    const departureTerminal = resolveGoBusTerminal(terminals, web.departureId);
    const arrivalTerminal = resolveGoBusTerminal(terminals, web.arrivalId);
    const response = await this.#http.post(context, {
      path: "ticket/selectIbtList2.do",
      body: {
        TIM_DTE: web.departureDate,
        TIM_TIM_I: `${web.departureTime.slice(0, 2)}00`,
        TER_FR_I: goBusTerminalCode(departureTerminal),
        TER_TO_I: goBusTerminalCode(arrivalTerminal),
        BUS_GRA_I: "9",
        CAL_FLG: "5",
        // Native schedule lookup requests a unit adult fare before passenger selection.
        CNT_100: "1",
        JOB_DIV: "",
        REQ_REC_NUM: "99999",
        POP_YN: "N",
      },
    });
    const schedule = parseGoBusValue(
      z.object({
        linelist: z.array(z.unknown()),
        timdte: z
          .string()
          .regex(/^\d{8}$/)
          .optional(),
      }),
      goBusAliases(response, {
        linelist: ["line_list", "LINE_LIST"],
        timdte: ["tim_dte", "TIM_DTE"],
      }),
    );
    if (schedule.timdte !== undefined && schedule.timdte !== web.departureDate)
      throw new GoBusError("trip_match");
    const rows = schedule.linelist.map((row) => {
      const normalized = goBusAliases(row, goBusRowAliases);
      const { timdte } = normalized;
      return parseGoBusValue(GoBusRowSchema, {
        ...normalized,
        timdte: timdte === undefined ? schedule.timdte : timdte,
      });
    });
    const matches = rows.filter(
      (row) =>
        row.rotid === web.routeId &&
        row.rotsqno === web.routeSequence &&
        row.alcndt === web.serviceDate &&
        row.alcnsqno === web.serviceSequence &&
        [departureTerminal.TER_COD, departureTerminal.TER_COD2].includes(row.terfri) &&
        [arrivalTerminal.TER_COD, arrivalTerminal.TER_COD2].includes(row.tertoi) &&
        row.timdte === web.departureDate &&
        row.timtim.padEnd(6, "0") === web.departureTime,
    );
    const row = matches[0];
    if (matches.length !== 1 || !row) throw new GoBusError("trip_match");
    if (web.passengers.adults > 0 && row.adltfee !== web.adultFareKrw)
      throw new GoBusError("fare_changed");
    return {
      service: "intercity",
      row,
      expectedAdultFareKrw: web.adultFareKrw,
      expectedTotalFareKrw: web.totalFareKrw,
      passengers: web.passengers,
      fareQuotes: web.fareQuotes,
      departureTerminal,
      arrivalTerminal,
    };
  }

  async readSeats(context: GoBusContext, trip: GoBusTrip): Promise<GoBusSeats> {
    const checked = GoBusTripSchema.safeParse(trip);
    if (!checked.success) throw new GoBusError("input");
    switch (checked.data.service) {
      case "express":
        return readGoExpressSeats(this.#http, context, checked.data);
      case "intercity":
        break;
      default:
        return assertNever(checked.data);
    }
    const row = checked.data.row;
    const response = await this.#http.post(context, {
      path: "ticket/selectIbtInfo.do",
      body: {
        TIM_DTE: row.timdte,
        TER_FR: row.terfro,
        TER_TO: row.tertoo,
        TIM_TIM: row.timtimo,
        TER_SFR: row.terfri,
        TER_STO: row.tertoi,
        TIM_TIM_I: row.timtim,
        BUS_GRA: row.busgrao,
        COR_COD: row.corcodo,
        ROT_ID: row.rotid,
        ROT_SQNO: row.rotsqno,
        ALCN_DT: row.alcndt,
        ALCN_SQNO: row.alcnsqno,
        AFC_OWNER_DVS_CD: row.afcownrdvscd,
        APP_VER: "",
      },
    });
    const info = parseGoBusValue(GoBusSeatInfoSchema, goBusAliases(response, goBusSeatAliases));
    if (
      (checked.data.passengers?.adults ?? 1) > 0 &&
      Number(info.tckfee1) !== checked.data.expectedAdultFareKrw
    )
      throw new GoBusError("fare_changed");
    return {
      trip: checked.data,
      info,
      selectableSeats: selectableGoSeats(info),
    };
  }

  async hold(
    context: GoBusContext,
    input: {
      readonly trip: GoBusTrip;
      readonly seats: readonly { readonly seat: number; readonly passengerType: GoPassengerType }[];
      readonly beforeMutation?: () => Promise<void>;
    },
  ): Promise<GoBusHold> {
    return holdGoSeats(this.#http, context, {
      ...input,
      readSeats: () => this.readSeats(context, input.trip),
    });
  }

  async release(
    context: GoBusContext,
    held: GoBusHold,
  ): Promise<{ readonly businessAccepted: true }> {
    return releaseGoSeats(this.#http, context, held);
  }
}
function assertNever(_value: never): never {
  throw new GoBusError("input");
}
