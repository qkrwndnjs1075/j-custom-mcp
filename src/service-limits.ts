import { z } from "zod";

const capacity = z.number().int().positive().safe();
const milliseconds = z.number().int().positive().max(2_147_483_647);
const seconds = z.number().int().positive().max(2_147_483);

export const ServiceLimitsSchema = z
  .strictObject({
    accounts: capacity.default(100),
    activeWatches: capacity.default(20),
    retainedWatches: capacity.default(80),
    retainedAlerts: capacity.default(1_000),
    cancellationQuotes: capacity.default(100),
    cancellationQuoteTtlSeconds: seconds.default(120),
    retainedCancellations: capacity.default(100),
    activeCancellations: capacity.default(20),
    activeBookings: capacity.default(20),
    retainedBookings: capacity.default(100),
    tripReferences: capacity.default(1_000),
    tripReferenceTtlSeconds: seconds.default(900),
    queryPages: capacity.default(10),
    querySeatChecks: capacity.default(10),
    queryTimeoutMs: milliseconds.default(30_000),
    journeyLegs: capacity.default(10),
    journeyResults: capacity.default(100),
    journeyCombinations: capacity.default(1_000),
    bookingCandidates: capacity.default(20),
    schedulerUsers: capacity.default(10),
    schedulerIntervalMs: milliseconds.default(30_000),
    minimumPollSeconds: seconds.default(300),
    maximumPollSeconds: seconds.default(86_400),
    alertMatches: capacity.default(20),
    alertPageSize: capacity.default(100),
  })
  .refine((limits) => limits.activeCancellations <= limits.retainedCancellations, {
    message: "retainedCancellations must be at least activeCancellations",
  })
  .refine((limits) => limits.activeBookings <= limits.retainedBookings, {
    message: "retainedBookings must be at least activeBookings",
  })
  .refine((limits) => limits.minimumPollSeconds <= limits.maximumPollSeconds, {
    message: "maximumPollSeconds must be at least minimumPollSeconds",
  })
  .readonly();

export type ServiceLimits = z.infer<typeof ServiceLimitsSchema>;
export const DEFAULT_SERVICE_LIMITS = ServiceLimitsSchema.parse({});

export const ServiceLimitsEnvironmentSchema = z
  .string()
  .default("{}")
  .transform((value, context) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      context.addIssue({ code: "custom", message: "MCP_LIMITS must contain a JSON object" });
      return z.NEVER;
    }
  })
  .pipe(ServiceLimitsSchema);
