import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";

export const OAuthTextSchema = z.string().min(1).max(2048);
export const OAuthClientSchema = z
  .object({
    client_id: z.string().uuid(),
    client_name: z.string().min(1).max(120),
    redirect_uris: z.array(z.string().url()).min(1).max(5),
    token_endpoint_auth_method: z.literal("none"),
    grant_types: z.array(z.enum(["authorization_code", "refresh_token"])),
    response_types: z.tuple([z.literal("code")]),
  })
  .readonly();
export type OAuthClient = z.infer<typeof OAuthClientSchema>;
export type OAuthFailureCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_scope"
  | "invalid_token"
  | "unsupported_grant_type"
  | "temporarily_unavailable";
export class OAuthServiceError extends Error {
  override readonly name = "OAuthServiceError";
  constructor(readonly code: OAuthFailureCode) {
    super(code);
  }
}
export function oauthSecret() {
  return randomBytes(32).toString("base64url");
}
export function oauthDigest(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}
export function oauthRedirect(value: string) {
  const parsed = z.url().safeParse(value);
  if (!parsed.success) throw new OAuthServiceError("invalid_request");
  const url = new URL(parsed.data);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new OAuthServiceError("invalid_request");
  return value;
}
export function oauthParse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new OAuthServiceError("invalid_request");
  return parsed.data;
}
