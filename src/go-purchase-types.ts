import { z } from "zod";
import {
  GO_MAX_SEAT_NUMBER,
  GoHeldSeatSchema,
  goHeldSeats,
  goSeatFare,
  validateGoHoldFare,
} from "./go-bus-fares";
import { StoredGoBusTripSchema } from "./go-bus-trip-schema";
import { GoBusError, type GoBusHold, GoBusSeatInfoSchema } from "./go-bus-types";

const messages = {
  configuration: "GO purchase configuration is invalid.",
  unsupported: "GO purchase passenger, fare, or payment selection is unsupported.",
  payment_unavailable: "A registered Naver Pay automatic payment method is required.",
  response: "GO purchase response is unsupported.",
  rejected: "GO purchase request was rejected.",
  network: "GO purchase inquiry failed.",
  reserve_uncertain: "GO payment reservation outcome is unknown; do not repeat the purchase.",
  purchase_uncertain: "GO ticket issuance outcome is unknown; reconcile before any further action.",
} as const;

const providerCode = z.string().regex(/^[A-Za-z0-9]{1,12}$/);
export const GO_PURCHASE_TEXT_MAX_LENGTH = 16384;
const fieldShape = z
  .object({
    present: z.boolean(),
    string: z.boolean(),
    nonempty: z.boolean(),
    withinBound: z.boolean(),
  })
  .readonly();
export const GoPurchaseDiagnosticSchema = z
  .object({
    stage: z.literal("reserve"),
    category: z.enum([
      "transport",
      "timeout",
      "http",
      "invalid_json",
      "provider_status",
      "response_shape",
    ]),
    httpStatus: z.number().int().min(100).max(599).optional(),
    providerCodes: z
      .object({ rstCd: providerCode.optional(), rspCd: providerCode.optional() })
      .readonly(),
    fields: z
      .object({
        dataObject: z.boolean(),
        order: fieldShape,
        cardAuthorization: fieldShape,
        authorization: fieldShape,
      })
      .readonly(),
  })
  .readonly();
export type GoPurchaseDiagnostic = z.infer<typeof GoPurchaseDiagnosticSchema>;

function responseObject(value: unknown): {
  readonly dta?: unknown;
  readonly rstCd?: unknown;
  readonly rspCd?: unknown;
  readonly [key: string]: unknown;
} {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

export function reserveFailureDiagnostic(
  raw: unknown,
  httpStatus?: number,
  category?: GoPurchaseDiagnostic["category"],
): GoPurchaseDiagnostic {
  const envelope = responseObject(raw);
  const data = responseObject(envelope.dta);
  const code = (value: unknown) => {
    const parsed = providerCode.safeParse(
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : value,
    );
    return parsed.success ? parsed.data : undefined;
  };
  const rstCd = code(envelope.rstCd);
  const rspCd = code(data.rspCd);
  const shape = (key: string) => ({
    present: Object.hasOwn(data, key),
    string: typeof data[key] === "string",
    nonempty: typeof data[key] === "string" && data[key].length > 0,
    withinBound: typeof data[key] === "string" && data[key].length <= GO_PURCHASE_TEXT_MAX_LENGTH,
  });
  return GoPurchaseDiagnosticSchema.parse({
    stage: "reserve",
    category:
      category ??
      ((rstCd !== undefined && rstCd !== "200") || (rspCd !== undefined && rspCd !== "0000")
        ? "provider_status"
        : "response_shape"),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    providerCodes: {
      ...(rstCd === undefined ? {} : { rstCd }),
      ...(rspCd === undefined ? {} : { rspCd }),
    },
    fields: {
      dataObject:
        typeof envelope.dta === "object" && envelope.dta !== null && !Array.isArray(envelope.dta),
      order: shape("oderSno"),
      cardAuthorization: shape("authDataCard"),
      authorization: shape("authDataAuth"),
    },
  });
}

export class GoPurchaseError extends Error {
  override readonly name = "GoPurchaseError";
  readonly diagnostic: GoPurchaseDiagnostic | undefined;
  constructor(
    readonly code: keyof typeof messages,
    diagnostic?: unknown,
  ) {
    super(messages[code]);
    const parsed = GoPurchaseDiagnosticSchema.safeParse(diagnostic);
    this.diagnostic = parsed.success ? parsed.data : undefined;
  }
}

const holdBase = {
  trip: StoredGoBusTripSchema,
  info: GoBusSeatInfoSchema,
};
export const GoPurchaseHoldSchema = z
  .union([
    z.strictObject({
      ...holdBase,
      seats: z.array(GoHeldSeatSchema).min(1).max(GO_MAX_SEAT_NUMBER).readonly(),
    }),
    z.strictObject({
      ...holdBase,
      seat: z.string().regex(/^(?:0[1-9]|[1-8][0-9]|9[0-8])$/),
      holdId: z.string().min(1).max(1024),
      ticketKind: z.literal("IG00"),
    }),
  ])
  .readonly();

export type GoPurchaseOutcome =
  | { readonly status: "unknown" }
  | {
      readonly status: "confirmed";
      readonly orderNumber: string;
      readonly ticketNumber: string;
      readonly seat: string;
      readonly fareKrw: number;
      readonly tickets?: readonly {
        readonly ticketNumber: string;
        readonly seat: string;
        readonly fareKrw: number;
      }[];
    };

export type GoPurchaseLookup = {
  readonly hold: GoBusHold;
  readonly memberSerialNumber: string;
  readonly purchaseMonth: string;
  readonly paymentOrderNumber?: string;
  readonly receiptBaseline?: readonly string[];
};

export function buildGoIssueBody(hold: GoBusHold) {
  const parsed = GoPurchaseHoldSchema.safeParse(hold);
  if (!parsed.success) throw new GoPurchaseError("unsupported");
  switch (parsed.data.trip.service) {
    case "express":
      throw new GoPurchaseError("unsupported");
    case "intercity":
      break;
    default:
      return assertNever(parsed.data.trip);
  }
  const { row, expectedAdultFareKrw } = parsed.data.trip;
  const seats = goHeldSeats(parsed.data);
  let total: number;
  try {
    total = validateGoHoldFare(parsed.data);
  } catch (error) {
    if (error instanceof GoBusError) throw new GoPurchaseError("unsupported");
    throw error;
  }
  const adults = seats.filter((seat) => seat.passengerType === "adult");
  const children = seats.filter((seat) => seat.passengerType === "child");
  const students = seats.filter((seat) => seat.passengerType === "student");
  const info = parsed.data.info;
  if (
    row.terfro.length <= 3 ||
    (adults.length > 0 &&
      (row.adltfee !== expectedAdultFareKrw || Number(info.tckfee1) !== expectedAdultFareKrw)) ||
    !row.lintim ||
    !row.tckpay ||
    !info.DIST
  ) {
    throw new GoPurchaseError("unsupported");
  }
  const optional: Record<string, string> & { FEE9_TYPE?: string } = {};
  for (const [key, value] of Object.entries({
    IV30_FEE: info.vtr30,
    IV50_FEE: info.vtr50,
    IV70_FEE: info.vtr70,
    BUS_CLS_PRIN_YN: info.BUS_CLS_PRIN_YN,
    BUS_CACM_NM_PRIN_YN: info.BUS_CACM_NM_PRIN_YN,
    DEPR_TIME_PRIN_YN: info.DEPR_TIME_PRIN_YN,
    SATS_NO_PRIN_YN: info.SATS_NO_PRIN_YN,
  })) {
    if (value !== undefined) optional[key] = value;
  }
  const student = students[0];
  if (student) optional.FEE9_TYPE = student.ticketKind.slice(2, 3);
  return {
    ...optional,
    TOT_AMT: String(total),
    ADM_KND_COD: "N",
    TCK_DIV: "01",
    LIN_TIM: row.lintim,
    CAR_COD: "NA",
    LIN_END1: info.DIST,
    USR_CHK: "1",
    TIM_DTE: row.timdte,
    TER_FR: row.terfro,
    TER_TO: row.tertoo,
    TIM_TIM_I: row.timtimo,
    TIM_TIM: row.timtim,
    TER_SFR: row.terfri,
    TER_STO: row.tertoi,
    BUS_GRA: row.busgrao,
    COR_COD: row.corcodo,
    TISSU_MNS_CD: "GA11",
    USR_ID: "0900000217",
    CNT_050: String(children.length),
    AMT_050: "0",
    AMT_100: String(students.length),
    CNT_100: String(adults.length),
    VTRN_NO: "",
    VTRN_AUTH_ID: "",
    IV30: "0",
    IV50: "0",
    IV70: "0",
    SATS_PCPY_ID: seats.map((seat) => seat.holdId).join(":"),
    SET_NO_WEB: seats.map((seat) => seat.seat).join(":"),
    ROT_ID: row.rotid,
    ROT_SQNO: row.rotsqno,
    ALCN_DT: row.alcndt,
    ALCN_SQNO: row.alcnsqno,
    AFC_OWNR_DVS_CD: row.afcownrdvscd,
    TCK_FEE1: adults.length ? info.tckfee1 : "0",
    TCK_FEE2: children.length ? String(goSeatFare(info, "IC50")) : "0",
    TCK_FEE8: "0",
    TCK_FEE9: student ? String(goSeatFare(info, student.ticketKind)) : "0",
    TCK_PAY: row.tckpay,
    AGRM_YN: "",
  } satisfies Readonly<Record<string, string>>;
}
function assertNever(_value: never): never {
  throw new GoPurchaseError("unsupported");
}
