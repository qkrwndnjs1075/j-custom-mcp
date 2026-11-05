import { z } from "zod";

export const GoDeviceSchema = z
  .strictObject({
    uuid: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\x21-\x7e]+$/),
    osVer: z.string().regex(/^\d{1,3}$/),
  })
  .readonly();
export type GoDevice = z.infer<typeof GoDeviceSchema>;

export const TossIdentitySchema = z
  .strictObject({
    triggerType: z.literal("APP_SCHEME"),
    userName: z.string().trim().min(1).max(100),
    userPhone: z.string().regex(/^01\d{8,9}$/),
    userBirthday: z.string().regex(/^\d{8}$/),
  })
  .readonly();
export type TossIdentity = z.infer<typeof TossIdentitySchema>;

export const TossChallengeSchema = z
  .strictObject({
    txId: z.string().min(1).max(1024),
    reqSno: z.union([z.string().min(1).max(1024), z.number().int().nonnegative().safe()]),
    moappMbrsSno: z.string().min(1).max(256),
  })
  .readonly();
export type TossChallenge = z.infer<typeof TossChallengeSchema>;

const messages = {
  configuration: "GO authentication configuration is invalid.",
  input: "GO authentication input is invalid.",
  response: "GO authentication response is unsupported.",
  authentication_required: "GO authentication was not successful.",
  verification_unconfirmed: "GO identity verification could not be confirmed.",
  unsupported_member: "GO authentication requires a supported existing member.",
  http: "GO authentication request was rejected.",
  network: "GO authentication connection failed.",
  timeout: "GO authentication request timed out.",
} as const;

export class GoAuthError extends Error {
  override readonly name = "GoAuthError";
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
