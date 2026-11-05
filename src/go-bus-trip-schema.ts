import { z } from "zod";
import { GoBusTerminalSchema } from "./go-bus-terminals";
import { GoBusRowSchema } from "./go-bus-types";
import { GoExpressTripSchema } from "./go-express-types";
import { FareQuotesSchema, PassengersSchema } from "./passengers";

export const GoIntercityTripSchema = z
  .strictObject({
    service: z.literal("intercity"),
    row: GoBusRowSchema,
    expectedAdultFareKrw: z.number().int().nonnegative(),
    expectedTotalFareKrw: z.number().int().positive().optional(),
    passengers: PassengersSchema.optional(),
    fareQuotes: FareQuotesSchema.optional(),
    departureTerminal: GoBusTerminalSchema,
    arrivalTerminal: GoBusTerminalSchema,
  })
  .readonly();
export const GoBusTripSchema = z.union([GoIntercityTripSchema, GoExpressTripSchema]);
const legacyIntercityTrip = GoIntercityTripSchema.unwrap()
  .omit({ service: true })
  .extend({ service: z.never().optional() })
  .transform((trip) => ({ ...trip, service: "intercity" as const }))
  .readonly();
export const StoredGoBusTripSchema = z.union([GoBusTripSchema, legacyIntercityTrip]);
