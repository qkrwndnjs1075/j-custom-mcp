import { z } from "zod";
import type { BusService } from "./bus-service";
import { FareQuotesSchema } from "./passengers";
import type { IntercityTrip, Trip } from "./trip-types";

export type { ExpressTrip, IntercityTrip, Trip } from "./trip-types";
export { ExpressTripSchema, IntercityTripSchema, StoredTripSchema, TripSchema } from "./trip-types";

const identifier = z.string().min(1);
const integer = z.union([
  z.number().int().nonnegative(),
  z.string().regex(/^\d+$/).transform(Number),
]);

export class ProviderError extends Error {
  readonly name = "ProviderError";
  constructor(
    readonly code: "http" | "timeout" | "network" | "layout" | "unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function parseProviderValue<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ProviderError("layout", "Provider response does not match its schema", {
      cause: result.error,
    });
  }
  return result.data;
}

export const TerminalSchema = z
  .object({
    trml_Cd: identifier,
    trml_Nm: z.string().min(1),
    cty_Bus_Area_Nm: z.string(),
  })
  .transform((value) => ({
    service: "intercity" as const,
    id: value.trml_Cd,
    name: value.trml_Nm,
    area: value.cty_Bus_Area_Nm,
  }))
  .readonly();
export type Terminal = {
  readonly service: BusService;
  readonly id: string;
  readonly name: string;
  readonly area: string;
};

export type UnavailableTrip = {
  readonly service: BusService;
  readonly tripKey: string | null;
  readonly departureTime: string;
  readonly carrierName: string;
  readonly busClassName: string;
  readonly adultFareKrw: number | null;
  readonly estimatedDurationMinutes: number | null;
  readonly availability: "sold_out" | "unavailable" | "unknown";
  readonly providerStatus: string;
};

export type TripPage = {
  readonly trips: readonly Trip[];
  readonly unavailable: readonly UnavailableTrip[];
  readonly continuation: string | null;
  readonly coverage: "more" | "end";
  readonly emptyStatus: "none" | "unknown_empty";
};

export const SeatMapSchema = z
  .object({
    seats: z
      .array(
        z
          .object({
            number: integer.refine((value) => value > 0),
            available: z.boolean(),
            row: z.number().int().positive().nullable().default(null),
            column: z.number().int().positive().nullable().default(null),
            side: z.enum(["left", "right", "rear", "unknown"]).default("unknown"),
          })
          .readonly(),
      )
      .min(1)
      .readonly(),
    adultFareKrw: integer.nullable(),
    fareQuotes: FareQuotesSchema.optional(),
    layoutStatus: z.enum(["verified", "unknown"]).default("unknown"),
    adjacentGroups: z.array(z.array(z.number().int().positive()).readonly()).readonly().default([]),
  })
  .transform((value) => ({
    ...value,
    fareQuotes: value.fareQuotes ?? {
      adults:
        value.adultFareKrw === null
          ? null
          : { unitFareKrw: value.adultFareKrw, fareKindCode: null },
      students: null,
      children: null,
    },
    totalSeats: value.seats.length,
    availableSeats: value.seats.filter((seat) => seat.available).length,
  }))
  .readonly();
export type SeatMap = z.infer<typeof SeatMapSchema>;

// Argument order comes from the site's readSasFeeInf function.
export const tripFields = [
  ["routeId", "rot_Id"],
  ["routeSequence", "rot_Sqno"],
  ["serviceDate", "alcn_Dt"],
  ["serviceSequence", "alcn_Sqno"],
  ["departureId", "depr_Trml_Cd"],
  ["arrivalId", "arvl_Trml_Cd"],
  ["departureName", "depr_Trml_Nm"],
  ["arrivalName", "arvl_Trml_Nm"],
  ["scheduledDepartureTime", "depr_Time"],
  ["carrierId", "bus_Cacm_Cd"],
  ["busClassId", "bus_Cls_Cd"],
  ["carrierName", "bus_Cacm_Nm"],
  ["busClassName", "bus_Cls_Nm"],
  ["adultCount", "ig"],
  ["studentCount", "im"],
  ["childCount", "ic"],
  ["remainingSeats", "rmn_Scnt"],
  ["totalSeats", "sats_Num"],
  ["departureDate", "atl_Depr_Dt"],
  ["departureTime", "atl_Depr_Time"],
  ["discountAvailable", "dc_Psb_Yn"],
] as const satisfies readonly (readonly [keyof IntercityTrip, string])[];

export function createSeatForm(trip: IntercityTrip): URLSearchParams {
  const body = new URLSearchParams(
    tripFields.map(([key, parameter]) => [parameter, String(trip[key])]),
  );
  body.set("atl_Depr_Dt_S1", trip.departureDate);
  body.set("atl_Depr_Time_S1", trip.departureTime);
  return body;
}
