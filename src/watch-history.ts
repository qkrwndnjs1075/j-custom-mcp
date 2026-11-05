import { z } from "zod";
import { PreServiceTripCriteriaSchema, TimeSchema } from "./query-types";
import {
  AlertPayloadSchema,
  WatchMatchSchema,
  WatchModeSchema,
  WatchSpecSchema,
} from "./watch-types";

// Only the original persisted format is accepted here; modern fields cannot downgrade.
const LegacyCriteriaSchema = z
  .strictObject({
    departureId: z.string().regex(/^\d{7}$/),
    arrivalId: z.string().regex(/^\d{7}$/),
    date: z.iso.date(),
    time: TimeSchema.optional(),
    endTime: TimeSchema.optional(),
    maxFareKrw: z.number().int().positive().optional(),
    minSeats: z.number().int().positive().optional(),
    adjacentSeats: z.number().int().min(2).optional(),
    departureTime: TimeSchema.optional(),
    preferredTime: TimeSchema.optional(),
  })
  .transform((criteria) => ({ ...criteria, service: "intercity" as const }));
const LegacySpecSchema = z.strictObject({
  criteria: LegacyCriteriaSchema,
  mode: WatchModeSchema,
  intervalSeconds: z.number().int().positive().optional(),
  expiresAt: z.iso.datetime({ offset: true }),
});
const LegacyMatchSchema = z
  .strictObject({
    tripKey: z.string().min(1),
    departureDate: z.string().min(1),
    departureTime: z.string().min(1),
    departureName: z.string().min(1),
    arrivalName: z.string().min(1),
    adultFareKrw: z.number().int().nonnegative(),
    remainingSeats: z.number().int().nonnegative(),
  })
  .transform((match) => ({ ...match, service: "intercity" as const }));
const LegacyAlertSchema = z.strictObject({
  mode: WatchModeSchema,
  criteria: LegacyCriteriaSchema,
  matches: z.array(LegacyMatchSchema).min(1).readonly(),
  matchCount: z.number().int().positive(),
});
const PreServiceSpecSchema = z
  .strictObject({
    ...WatchSpecSchema.unwrap().shape,
    criteria: PreServiceTripCriteriaSchema,
  })
  .transform(
    (spec): z.input<typeof WatchSpecSchema> => ({
      ...spec,
      criteria: { ...spec.criteria, service: "intercity" as const },
    }),
  )
  .pipe(WatchSpecSchema);
const PreServiceMatchSchema = WatchMatchSchema.unwrap()
  .omit({ service: true })
  .extend({
    adultFareKrw: z.number().int().nonnegative(),
  })
  .transform((match) => ({
    ...match,
    service: "intercity" as const,
    tripKey: `intercity:${match.tripKey}`,
  }));
const PreServiceAlertSchema = AlertPayloadSchema.unwrap()
  .extend({
    criteria: PreServiceTripCriteriaSchema,
    matches: z.array(PreServiceMatchSchema).min(1).readonly(),
  })
  .transform(
    (alert): z.input<typeof AlertPayloadSchema> => ({
      ...alert,
      criteria: { ...alert.criteria, service: "intercity" as const },
    }),
  )
  .pipe(AlertPayloadSchema);
export function decodeStoredSpec(value: unknown) {
  const modern = WatchSpecSchema.safeParse(value);
  if (modern.success) return { schemaVersion: "current", spec: modern.data } as const;
  const historical = PreServiceSpecSchema.safeParse(value);
  if (historical.success) return { schemaVersion: "current", spec: historical.data } as const;
  return { schemaVersion: "legacy", spec: LegacySpecSchema.parse(value) } as const;
}
export function decodeStoredAlert(value: unknown) {
  const modern = AlertPayloadSchema.safeParse(value);
  if (modern.success) return { ...modern.data, schemaVersion: "current" } as const;
  const historical = PreServiceAlertSchema.safeParse(value);
  if (historical.success) return { ...historical.data, schemaVersion: "current" } as const;
  return { ...LegacyAlertSchema.parse(value), schemaVersion: "legacy" } as const;
}
export type LegacyWatchSpec = z.infer<typeof LegacySpecSchema>;
export type StoredAlertPayload = ReturnType<typeof decodeStoredAlert>;
