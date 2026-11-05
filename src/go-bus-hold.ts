import { z } from "zod";
import {
  GoHeldSeatSchema,
  GoProviderSeatSchema,
  GoSeatSelectionSchema,
  goHeldSeats,
  goTicketKind,
  validateGoHoldFare,
} from "./go-bus-fares";
import type { GoBusHttp } from "./go-bus-http";
import { GoBusTripSchema } from "./go-bus-trip-schema";
import {
  type GoBusContext,
  GoBusError,
  type GoBusHold,
  type GoBusSeats,
  type GoBusTrip,
  type GoIntercityTrip,
  type GoPassengerType,
} from "./go-bus-types";
import { holdGoExpressSeats, releaseGoExpressSeats } from "./go-express-hold";

const responseSchema = z.object({
  PCPY_LIST: z
    .array(
      z.object({
        SATS_NO: GoProviderSeatSchema,
        SATS_PCPY_ID: z
          .string()
          .min(1)
          .max(1024)
          .refine((value) => !value.includes(":")),
        BUS_TCK_KND_CD: z.enum(["IG00", "IC50", "IM10", "IM20", "IM30"]).optional(),
      }),
    )
    .min(1),
});
function holdBody(trip: GoIntercityTrip, count: number) {
  const row = trip.row;
  return {
    ROT_ID: row.rotid,
    ROT_SQNO: row.rotsqno,
    ALCN_DT: row.alcndt,
    ALCN_SQNO: row.alcnsqno,
    TER_SFR: row.terfri,
    TER_STO: row.tertoi,
    SATS_PCPY_NUM: String(count),
    CTY_BUS_DC_KND_CD: ":".repeat(count - 1),
    DCRT_DVS_CD: ":".repeat(count - 1),
    RTRP_DEPR_DT: "00000000",
  };
}
export async function holdGoSeats(
  http: GoBusHttp,
  context: GoBusContext,
  input: {
    readonly trip: GoBusTrip;
    readonly seats: readonly { readonly seat: number; readonly passengerType: GoPassengerType }[];
    readonly beforeMutation?: () => Promise<void>;
    readonly readSeats: () => Promise<GoBusSeats>;
  },
): Promise<GoBusHold> {
  const parsed = GoSeatSelectionSchema.safeParse(input.seats);
  if (!parsed.success || input.trip.expectedTotalFareKrw === undefined)
    throw new GoBusError("input");
  const available = await input.readSeats();
  const selected = parsed.data
    .toSorted((a, b) => a.seat - b.seat)
    .map((selection) => {
      if (!available.selectableSeats.includes(selection.seat))
        throw new GoBusError("seat_unavailable");
      return {
        seat: String(selection.seat).padStart(2, "0"),
        passengerType: selection.passengerType,
        ticketKind: goTicketKind(available.info, selection.passengerType, available.trip.service),
        holdId: `preflight-${selection.seat}`,
      };
    });
  validateGoHoldFare({ trip: available.trip, info: available.info, seats: selected });
  await input.beforeMutation?.();
  switch (available.trip.service) {
    case "express":
      return holdGoExpressSeats(http, context, {
        available: { ...available, trip: available.trip },
        selected,
      });
    case "intercity":
      break;
    default:
      return assertNever(available.trip);
  }
  const response = await http.post(context, {
    path: "ticket/updatepcpysats.do",
    mutation: "hold",
    body: {
      ...holdBody(available.trip, selected.length),
      SATS_PCPY_DVS: "1",
      SATS_PCPY_ID: "",
      SATS_NO: selected.map((seat) => seat.seat).join(":"),
      BUS_TCK_KND_CD: selected.map((seat) => seat.ticketKind).join(":"),
    },
  });
  const result = responseSchema.safeParse(response);
  if (!result.success || result.data.PCPY_LIST.length !== selected.length)
    throw new GoBusError("hold_uncertain");
  const held = result.data.PCPY_LIST.map((item) => {
    const requested = selected.find((seat) => seat.seat === item.SATS_NO);
    if (
      !requested ||
      (item.BUS_TCK_KND_CD !== undefined && requested.ticketKind !== item.BUS_TCK_KND_CD)
    )
      throw new GoBusError("hold_uncertain");
    return { ...requested, holdId: item.SATS_PCPY_ID };
  });
  if (
    new Set(held.map((seat) => seat.seat)).size !== held.length ||
    new Set(held.map((seat) => seat.holdId)).size !== held.length
  )
    throw new GoBusError("hold_uncertain");
  return { trip: available.trip, info: available.info, seats: held };
}
export async function releaseGoSeats(
  http: GoBusHttp,
  context: GoBusContext,
  hold: GoBusHold,
): Promise<{ readonly businessAccepted: true }> {
  if (!("seats" in hold) || hold.trip.expectedTotalFareKrw === undefined)
    throw new GoBusError("input");
  const trip = GoBusTripSchema.safeParse(hold.trip);
  if (!trip.success) throw new GoBusError("input");
  switch (trip.data.service) {
    case "express":
      return releaseGoExpressSeats(http, context, hold);
    case "intercity":
      break;
    default:
      return assertNever(trip.data);
  }
  const seats = z.array(GoHeldSeatSchema).min(1).safeParse(goHeldSeats(hold));
  if (!seats.success) throw new GoBusError("input");
  await http.post(context, {
    path: "ticket/updatepcpysats.do",
    mutation: "release",
    body: {
      ...holdBody(trip.data, seats.data.length),
      SATS_PCPY_DVS: "2",
      SATS_PCPY_ID: seats.data.map((seat) => seat.holdId).join(":"),
      SATS_NO: seats.data.map((seat) => seat.seat).join(":"),
      BUS_TCK_KND_CD: seats.data.map((seat) => seat.ticketKind).join(":"),
    },
  });
  return { businessAccepted: true };
}
function assertNever(_value: never): never {
  throw new GoBusError("input");
}
