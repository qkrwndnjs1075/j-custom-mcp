import { z } from "zod";
import { GoDeviceSchema, TossChallengeSchema } from "./go-auth-types";
import { TossAppSchemeSchema } from "./toss-launch";
import { UserIdSchema } from "./user-types";

/** Server-only storage; implementations must protect credentials at rest. */
export interface StateStorage {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export const ConnectionSnapshotSchema = z.strictObject({
  rateWindow: z.number().int().nonnegative(),
  rateCount: z.number().int().nonnegative(),
  sessions: z
    .array(
      z.tuple([
        z.string().regex(/^[a-f0-9]{64}$/),
        z.strictObject({
          phase: z.enum(["consent", "identity", "waiting", "connected", "disconnected", "error"]),
          csrf: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
          expiresAt: z.number().finite(),
          busy: z.boolean(),
          attempts: z.number().int().nonnegative(),
          finishes: z.number().int().nonnegative(),
          oauth: z.unknown().optional(),
          challenge: z
            .strictObject({
              device: GoDeviceSchema,
              request: TossChallengeSchema,
              appScheme: TossAppSchemeSchema,
            })
            .optional(),
          user: z.strictObject({ userId: UserIdSchema, connectionId: z.string() }).optional(),
          message: z.string().optional(),
        }),
      ]),
    )
    .max(128),
});
