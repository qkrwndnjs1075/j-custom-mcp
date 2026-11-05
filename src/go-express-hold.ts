import { z } from "zod";
import { GoProviderSeatSchema } from "./go-bus-fares";
import type { GoBusHttp } from "./go-bus-http";
import {
  type GoBusContext,
  GoBusError,
  type GoBusHold,
  type GoBusSeats,
  type GoHeldSeat,
} from "./go-bus-types";
import { GoExpressHoldSchema, type GoExpressTrip } from "./go-express-types";

const responseSchema = z.object({
  pcpy_list: z
    .array(
      z.object({
        set_no: GoProviderSeatSchema,
        pcpy_no: z
          .string()
          .min(1)
          .max(1024)
          .refine((value) => !value.includes(":")),
      }),
    )
    .min(1),
});
export async function holdGoExpressSeats(
  http: GoBusHttp,
  context: GoBusContext,
  input: {
    readonly available: GoBusSeats & { readonly trip: GoExpressTrip };
    readonly selected: readonly GoHeldSeat[];
  },
): Promise<GoBusHold> {
  const { available, selected } = input;
  const row = available.trip.row;
  const raw = await http.post(context, {
    service: "express",
    path: "ticket/insertPcpyNo.do",
    mutation: "hold",
    body: {
      tim_dte: row.timdte,
      ter_fr: row.terfro,
      ter_to: row.tertoo,
      tim_tim_i: row.timtimo,
      tim_tim: row.timtim,
      ter_sfr: row.terfri,
      ter_sto: row.tertoi,
      bus_gra: row.busgrao,
      cor_cod: row.corcodo,
      tot_cnt: row.webcnt,
      set_cnt: String(selected.length),
      set_no_web: selected.map((seat) => seat.seat).join(":"),
    },
  });
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.pcpy_list.length !== selected.length)
    throw new GoBusError("hold_uncertain");
  const seats = parsed.data.pcpy_list.map((item) => {
    const original = selected.find((seat) => seat.seat === item.set_no);
    if (!original) throw new GoBusError("hold_uncertain");
    return { ...original, holdId: item.pcpy_no };
  });
  if (
    new Set(seats.map((seat) => seat.seat)).size !== seats.length ||
    new Set(seats.map((seat) => seat.holdId)).size !== seats.length
  )
    throw new GoBusError("hold_uncertain");
  return { trip: available.trip, info: available.info, seats };
}

export async function releaseGoExpressSeats(
  http: GoBusHttp,
  context: GoBusContext,
  hold: GoBusHold,
): Promise<{ readonly businessAccepted: true }> {
  const checked = GoExpressHoldSchema.safeParse(hold);
  if (!checked.success) throw new GoBusError("input");
  const {
    seats,
    trip: { row },
  } = checked.data;
  if (
    new Set(seats.map((seat) => seat.seat)).size !== seats.length ||
    new Set(seats.map((seat) => seat.holdId)).size !== seats.length
  )
    throw new GoBusError("input");
  await http.post(context, {
    service: "express",
    path: "ticket/deletePcpyNo.do",
    mutation: "release",
    body: {
      set_no: seats.map((seat) => seat.seat).join(":"),
      pcpy_cnt: seats.length,
      pcpy_no_arr: seats.map((seat) => seat.holdId).join(":"),
      ter_fr: row.terfro,
      ter_to: row.tertoo,
      ter_sfr: row.terfri,
      ter_sto: row.tertoi,
    },
  });
  return { businessAccepted: true };
}
