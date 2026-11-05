import { z } from "zod";
import { BusServiceSchema } from "./bus-service";
import { FareQuotesSchema, PassengersSchema } from "./passengers";
import { type TripCriteria, TripCriteriaSchema } from "./query-types";
import { DEFAULT_SERVICE_LIMITS } from "./service-limits";
import type { LegacyWatchSpec, StoredAlertPayload } from "./watch-history";

export const WatchCriteriaSchema = TripCriteriaSchema;
export type WatchCriteria = TripCriteria;
export const WatchModeSchema = z.enum(["seats_available", "booking_available"]);
export function watchDeadline(criteria: Pick<WatchCriteria, "date" | "endTime">): string {
  return new Date(`${criteria.date}T${criteria.endTime}:59.999+09:00`).toISOString();
}
export const WatchSpecSchema = z
  .strictObject({
    criteria: WatchCriteriaSchema,
    mode: WatchModeSchema,
    notification: z.enum(["on_transition", "every_match"]),
    retryPolicy: z.discriminatedUnion("mode", [
      z.strictObject({ mode: z.literal("fixed_interval") }),
      z.strictObject({
        mode: z.literal("exponential_backoff"),
        maxIntervalSeconds: z.number().int().positive().safe(),
      }),
    ]),
    intervalSeconds: z.number().int().positive().safe(),
    expiresAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  })
  .refine(
    (spec) =>
      spec.retryPolicy.mode !== "exponential_backoff" ||
      spec.retryPolicy.maxIntervalSeconds >= spec.intervalSeconds,
    { message: "Retry maximum must be at least intervalSeconds" },
  )
  .refine((spec) => Date.parse(spec.expiresAt) <= Date.parse(watchDeadline(spec.criteria)), {
    message: "Watch expiry cannot be later than the travel date's endTime in Korea",
    path: ["expiresAt"],
  })
  .readonly();
export type WatchSpec = z.infer<typeof WatchSpecSchema>;

export const WatchMatchSchema = z
  .strictObject({
    service: BusServiceSchema,
    tripKey: z.string().min(1),
    departureDate: z.string().min(1),
    departureTime: z.string().min(1),
    departureName: z.string().min(1),
    arrivalName: z.string().min(1),
    passengers: PassengersSchema,
    fareQuotes: FareQuotesSchema,
    totalFareKrw: z.number().int().nonnegative().safe(),
    adultFareKrw: z.number().int().nonnegative().nullable(),
    remainingSeats: z.number().int().nonnegative(),
  })
  .readonly();
export type WatchMatch = z.infer<typeof WatchMatchSchema>;
export type Observation =
  | { readonly kind: "matched"; readonly matches: readonly WatchMatch[] }
  | { readonly kind: "not_matched" }
  | { readonly kind: "inconclusive"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

export type WatchState = {
  readonly id: string;
  readonly status: "active" | "cancelled" | "expired";
  readonly createdAt: string;
  readonly nextCheckAt: string;
  readonly lastCheckedAt: string | null;
  readonly lastOutcome: Observation["kind"] | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
};

export type Watch = WatchSpec & WatchState;
export type LegacyWatch = LegacyWatchSpec & WatchState & { readonly schemaVersion: "legacy" };
export type StoredWatch = Watch | LegacyWatch;

export const AlertPayloadSchema = z
  .strictObject({
    mode: WatchModeSchema,
    criteria: WatchCriteriaSchema,
    matches: z.array(WatchMatchSchema).min(1).readonly(),
    matchCount: z.number().int().positive(),
  })
  .readonly();
export type WatchAlert = StoredAlertPayload & {
  readonly cursor: number;
  readonly watchId: string;
  readonly generatedAt: string;
  readonly delivery: "inbox_only";
};
export const AlertQuerySchema = z
  .strictObject({
    after: z.number().int().nonnegative().safe(),
    limit: z.number().int().positive().safe(),
  })
  .readonly();
export type AlertPage = {
  readonly alerts: readonly WatchAlert[];
  readonly oldestCursor: number | null;
  readonly latestCursor: number;
  readonly nextCursor: number;
  readonly hasMore: boolean;
  readonly gap: boolean;
};

export const WATCH_LIMITS = {
  active: DEFAULT_SERVICE_LIMITS.activeWatches,
  inactive: DEFAULT_SERVICE_LIMITS.retainedWatches,
  alerts: DEFAULT_SERVICE_LIMITS.retainedAlerts,
} as const;

export class WatchError extends Error {
  readonly name = "WatchError";
  constructor(
    readonly code:
      | "capacity"
      | "expired"
      | "invalid_observation"
      | "invalid_interval"
      | "invalid_pagination",
    message: string,
  ) {
    super(message);
  }
}

export function watchDedupeKey(spec: WatchSpec): string {
  return JSON.stringify([
    spec.mode,
    spec.criteria,
    spec.intervalSeconds,
    spec.expiresAt,
    spec.notification,
    spec.retryPolicy,
  ]);
}
