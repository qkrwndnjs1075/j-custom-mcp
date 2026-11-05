import type { GoBusRow } from "./go-bus-row";

export { type GoBusRow, GoBusRowSchema, goBusRowAliases } from "./go-bus-row";

import { z } from "zod";
import { GoSessionSchema } from "./go-account";
import type { GoHeldSeatSchema } from "./go-bus-fares";
import type { GoBusTerminal } from "./go-bus-terminals";
import type { GoExpressTrip } from "./go-express-types";
import type { FareQuotes, Passengers } from "./passengers";

const text = z.string().max(1024);
const header = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[\x21-\x7e]+$/);

export const GoBusContextSchema = z
  .strictObject({
    session: GoSessionSchema,
    userNumber: text,
    osRelease: header,
    country: z.string().regex(/^[A-Z]{2}$/),
    ipAddress: z.union([z.literal(""), z.ipv4()]),
  })
  .readonly();
export type GoBusContext = z.infer<typeof GoBusContextSchema>;

const messages = {
  cancellation_uncertain: "GO bus cancellation outcome is unknown; reconcile before retrying.",
  acknowledgement_uncertain: "GO bus cancellation acknowledgement is unknown.",
  configuration: "GO bus configuration is invalid.",
  input: "GO bus request is invalid.",
  response: "GO bus response is unsupported.",
  authentication_required: "GO bus authentication is required.",
  rejected: "GO bus request was rejected.",
  network: "GO bus connection failed.",
  timeout: "GO bus request timed out.",
  trip_match: "GO bus journey could not be matched uniquely.",
  fare_changed: "GO bus fare differs from the selected journey.",
  seat_unavailable: "GO bus seat is not confirmed selectable.",
  hold_uncertain: "GO bus hold outcome is unknown; do not retry.",
  release_uncertain: "GO bus release outcome is unknown.",
  purchase_uncertain: "GO bus purchase outcome is unknown; reconcile before retrying.",
} as const;

export class GoBusError extends Error {
  override readonly name = "GoBusError";
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}

export function parseGoBusValue<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new GoBusError("response");
  return parsed.data;
}

export function goBusAliases(input: unknown, aliases: Readonly<Record<string, readonly string[]>>) {
  const source = parseGoBusValue(z.record(z.string(), z.unknown()), input);
  const result: Record<string, unknown> = { ...source };
  for (const [canonical, names] of Object.entries(aliases)) {
    const values = [canonical, ...names]
      .filter((key) => source[key] !== undefined)
      .map((key) => source[key]);
    if (values.some((value) => JSON.stringify(value) !== JSON.stringify(values[0]))) {
      throw new GoBusError("response");
    }
    if (values.length) result[canonical] = values[0];
  }
  return result;
}

export type GoIntercityTrip = {
  readonly service: "intercity";
  readonly row: GoBusRow;
  readonly expectedAdultFareKrw: number;
  readonly expectedTotalFareKrw?: number | undefined;
  readonly passengers?: Passengers | undefined;
  readonly fareQuotes?: FareQuotes | undefined;
  readonly departureTerminal: GoBusTerminal;
  readonly arrivalTerminal: GoBusTerminal;
};
export type GoBusTrip = GoIntercityTrip | GoExpressTrip;

export const GoBusSeatInfoSchema = z
  .object({
    tckfee1: z.string().regex(/^\d+$/),
    totcnt: z.string().regex(/^\d+$/),
    seatlist: z.array(z.record(z.string().regex(/^\d{1,2}$/), z.string())).readonly(),
    occncnt: text.optional(),
    occycnt: text.optional(),
    IBT_SEAT_TYPE: text.optional(),
    SEAT_DC_TARGET: text.optional(),
    DIST: text.optional(),
    TAKE_DRTM: text.optional(),
    BUS_CACM_NM_PRIN_YN: text.optional(),
    BUS_CLS_PRIN_YN: text.optional(),
    DEPR_TIME_PRIN_YN: text.optional(),
    SATS_NO_PRIN_YN: text.optional(),
    DC_BFR_AMT: text.optional(),
    DC_PSB_YN: text.optional(),
    JNT_DC_FEE: text.optional(),
    JNT_DC_RTO: text.optional(),
    PRE_DC_RNG_TIM: text.optional(),
    PRE_OCC_DC_FEE: text.optional(),
    PRE_OCC_DC_RTO: text.optional(),
    RND_DC_FEE: text.optional(),
    RND_DC_RTO: text.optional(),
    SEAT_DC_FEE: text.optional(),
    SEAT_DC_RTO: text.optional(),
    tckfee2: text.optional(),
    tckfee8: text.optional(),
    tckfee9: text.optional(),
    tckfee91: text.optional(),
    tckfee92: text.optional(),
    tckfee93: text.optional(),
    vtr30: text.optional(),
    vtr50: text.optional(),
    vtr70: text.optional(),
    dsprfee: text.optional(),
    mp00fee: text.optional(),
    sncnfee: text.optional(),
    tckfee1NoDc: text.optional(),
    tckfee2NoDc: text.optional(),
    tckfee8NoDc: text.optional(),
    tckfee9NoDc: text.optional(),
    vtr30NoDc: text.optional(),
    vtr50NoDc: text.optional(),
    vtr70NoDc: text.optional(),
    dsprfeeNoDc: text.optional(),
    sncnfeeNoDc: text.optional(),
    lin_str1: text.optional(),
    maxCpnDto: text.optional(),
  })
  .readonly();
export type GoBusSeatInfo = z.infer<typeof GoBusSeatInfoSchema>;
export type GoBusSeats = {
  readonly trip: GoBusTrip;
  readonly info: GoBusSeatInfo;
  readonly selectableSeats: readonly number[];
};
export type GoHeldSeat = z.infer<typeof GoHeldSeatSchema>;
export type GoPassengerType = GoHeldSeat["passengerType"];
export type GoTicketKind = GoHeldSeat["ticketKind"];
export type GoBusHold = {
  readonly trip: GoBusTrip;
  readonly info: GoBusSeatInfo;
} & (
  | { readonly seats: readonly GoHeldSeat[] }
  | {
      readonly seat: string;
      readonly holdId: string;
      readonly ticketKind: "IG00";
    }
);

export const goBusSeatAliases = {
  tckfee1: ["TCK_FEE1", "tck_fee1", "tckFee1"],
  tckfee2: ["TCK_FEE2", "tck_fee2", "tckFee2"],
  tckfee8: ["TCK_FEE8", "tck_fee8", "tckFee8"],
  tckfee9: ["TCK_FEE9", "tck_fee9", "tckFee9"],
  tckfee91: ["TCK_FEE91", "tck_fee91", "tckFee91"],
  tckfee92: ["TCK_FEE92", "tck_fee92", "tckFee92"],
  tckfee93: ["TCK_FEE93", "tck_fee93", "tckFee93"],
  vtr30: ["IV30_FEE", "iv30Fee"],
  vtr50: ["IV50_FEE", "iv50Fee"],
  vtr70: ["IV70_FEE", "iv70Fee"],
  dsprfee: ["DSPR_FEE", "dspr_fee", "dsprFee"],
  mp00fee: ["MP00_FEE", "mp00_fee", "mp00Fee"],
  sncnfee: ["SNCN_FEE", "sncn_fee", "sncnFee"],
  totcnt: ["TOT_CNT", "tot_cnt"],
  seatlist: ["SEAT_LIST", "seat_list"],
  occncnt: ["OCC_N_CNT", "occ_n_cnt"],
  occycnt: ["OCC_Y_CNT", "occ_y_cnt"],
  DIST: ["dist"],
  TAKE_DRTM: ["takeDrtm"],
  maxCpnDto: ["MAX_CPN_RTO", "max_cpn_rto"],
} as const;
