import { z } from "zod";
import { BusServiceSchema, TerminalIdSchema, terminalMatchesService } from "./bus-service";
import { PassengersSchema } from "./passengers";

export { TerminalIdSchema } from "./bus-service";
export const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const criteriaFields = z.object({
  service: BusServiceSchema,
  departureId: TerminalIdSchema,
  arrivalId: TerminalIdSchema,
  date: z.iso.date(),
  time: TimeSchema,
  endTime: TimeSchema,
  passengers: PassengersSchema,
  ranking: z
    .array(z.enum(["preferred_time", "fare", "departure_time"]))
    .min(1)
    .max(3)
    .refine((keys) => new Set(keys).size === keys.length)
    .readonly(),
  maxFareKrw: z.number().int().positive().optional(),
  minSeats: z.number().int().positive(),
  adjacentSeats: z.number().int().min(2).optional(),
  departureTime: TimeSchema.optional(),
  preferredTime: TimeSchema.optional(),
});
export const TripCriteriaSchema = criteriaFields
  .refine(
    (criteria) =>
      terminalMatchesService(criteria.service, criteria.departureId) &&
      terminalMatchesService(criteria.service, criteria.arrivalId),
    { message: "Terminal IDs must belong to the selected bus service" },
  )
  .refine((criteria) => criteria.time <= criteria.endTime, {
    message: "endTime must be at or after time within the same day",
  })
  .refine(
    (criteria) =>
      !criteria.ranking.includes("preferred_time") || criteria.preferredTime !== undefined,
    { message: "preferred_time ranking requires preferredTime" },
  )
  .readonly();
export type TripCriteria = z.infer<typeof TripCriteriaSchema>;

export const PreServiceTripCriteriaSchema = criteriaFields
  .omit({ service: true })
  .extend({ service: z.never().optional() })
  .strict()
  .transform(
    (criteria): z.input<typeof TripCriteriaSchema> => ({ ...criteria, service: "intercity" }),
  )
  .pipe(TripCriteriaSchema);
export const StoredTripCriteriaSchema = z.union([TripCriteriaSchema, PreServiceTripCriteriaSchema]);

export const JourneySearchSchema = z
  .object({
    legs: z.array(TripCriteriaSchema).min(1).readonly(),
    ranking: z
      .array(z.enum(["total_fare", "total_preferred_time", "leg_order"]))
      .min(1)
      .max(3)
      .refine((keys) => new Set(keys).size === keys.length)
      .readonly(),
    maxTotalFareKrw: z.number().int().positive().optional(),
    maxResults: z.number().int().positive(),
  })
  .refine(
    (input) =>
      !input.ranking.includes("total_preferred_time") ||
      input.legs.every((leg) => leg.preferredTime !== undefined),
    { message: "total_preferred_time requires preferredTime on every leg" },
  )
  .readonly();
export type JourneySearch = z.infer<typeof JourneySearchSchema>;
