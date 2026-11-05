import { z } from "zod";
import { GO_MAX_SEAT_NUMBER, GoHeldSeatSchema } from "./go-bus-fares";
import { GoBusRowSchema, GoBusSeatInfoSchema } from "./go-bus-types";
import { FareQuotesSchema, PassengersSchema } from "./passengers";

const terminal = z
  .object({ TER_COD: z.string().regex(/^\d{3}$/), ARPR_TRML_YN: z.literal("N") })
  .readonly();
export const GoExpressRowSchema = GoBusRowSchema.unwrap()
  .omit({
    rotid: true,
    rotsqno: true,
    alcndt: true,
    alcnsqno: true,
    afcownrdvscd: true,
  })
  .extend({
    terfri: z.string().regex(/^\d{3}$/),
    tertoi: z.string().regex(/^\d{3}$/),
    terfro: z.string().regex(/^\d{3}$/),
    tertoo: z.string().regex(/^\d{3}$/),
    webcnt: z.string().regex(/^\d+$/),
    lintim: z.string().min(1),
    linend1: z.string().min(1),
    tckpay: z.string().min(1),
  })
  .readonly();
export const GoExpressTripSchema = z
  .strictObject({
    service: z.literal("express"),
    row: GoExpressRowSchema,
    expectedAdultFareKrw: z.number().int().nonnegative().nullable(),
    expectedTotalFareKrw: z.number().int().positive(),
    passengers: PassengersSchema,
    fareQuotes: FareQuotesSchema,
    departureTerminal: terminal,
    arrivalTerminal: terminal,
  })
  .readonly();
export type GoExpressTrip = z.infer<typeof GoExpressTripSchema>;
export const GoExpressHoldSchema = z
  .strictObject({
    trip: GoExpressTripSchema,
    info: GoBusSeatInfoSchema,
    seats: z
      .array(
        GoHeldSeatSchema.unwrap()
          .extend({ ticketKind: z.enum(["1", "2", "9"]) })
          .readonly(),
      )
      .min(1)
      .max(GO_MAX_SEAT_NUMBER)
      .readonly(),
  })
  .readonly();
