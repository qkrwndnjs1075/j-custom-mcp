import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import { type GoSession, GoSessionSchema } from "./go-account";
import {
  GoAuthError,
  type GoDevice,
  GoDeviceSchema,
  type TossChallenge,
  TossChallengeSchema,
  type TossIdentity,
  TossIdentitySchema,
} from "./go-auth-types";
import { createGoRefreshBody } from "./go-refresh";
import { rejectProviderRedirect } from "./http-policy";
import { TossAppSchemeSchema } from "./toss-launch";

export { GoAuthError, type GoDevice, type TossChallenge, type TossIdentity } from "./go-auth-types";

const tokenSchema = GoSessionSchema.unwrap().shape.token;
const outerSchema = z.object({
  rstCd: z.union([z.literal("200"), z.literal(200)]),
  dta: z.unknown(),
});
const tossEnvelopeSchema = z.object({ rspCd: z.string(), data: z.unknown().optional() });
const startSchema = z.object({
  ...TossChallengeSchema.unwrap().shape,
  appScheme: TossAppSchemeSchema,
});
const resultFlagsSchema = z.object({
  prsnAuthScsYn: z.enum(["Y", "N"]),
  joinYn: z.string().optional(),
  ageDvsCd: z.string().optional(),
});
const memberSchema = z.object({
  authTkn: tokenSchema,
  moappMbrsSno: z.string().min(1).max(256),
});

export class TmoneyGoAuthClient {
  readonly #http;
  readonly #timeoutMs: number;
  readonly #salt: string;
  readonly #now: () => Date;

  constructor(options: {
    readonly salt: string;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
    readonly now?: () => Date;
  }) {
    const config = z
      .object({
        salt: z.string().min(1).max(4096),
        timeoutMs: z.number().int().positive().max(2_147_483_647),
      })
      .safeParse({ salt: options.salt, timeoutMs: options.timeoutMs ?? 10_000 });
    if (!config.success) throw new GoAuthError("configuration");
    this.#salt = config.data.salt;
    this.#timeoutMs = config.data.timeoutMs;
    this.#now = options.now ?? (() => new Date());
    this.#http = ky.create({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      timeout: this.#timeoutMs,
      retry: 0,
      redirect: "manual",
      hooks: { afterResponse: [rejectProviderRedirect] },
    });
  }

  async startToss(device: GoDevice, identity: TossIdentity) {
    const input = TossIdentitySchema.safeParse(identity);
    if (!input.success) throw new GoAuthError("input");
    const data = await this.#postToss("auth", device, input.data);
    const parsed = startSchema.safeParse(data);
    if (!parsed.success) throw new GoAuthError("response");
    return parsed.data;
  }

  async completeToss(device: GoDevice, input: TossChallenge) {
    const parsedInput = TossChallengeSchema.safeParse(input);
    if (!parsedInput.success) throw new GoAuthError("input");
    const data = await this.#postToss("authResult", device, { ...parsedInput.data, encYn: "Y" });
    const flags = resultFlagsSchema.safeParse(data);
    if (!flags.success) throw new GoAuthError("response");
    if (flags.data.prsnAuthScsYn === "N") throw new GoAuthError("verification_unconfirmed");
    if (flags.data.joinYn !== "Y") {
      throw new GoAuthError("unsupported_member");
    }
    const member = memberSchema.safeParse(data);
    if (!member.success) throw new GoAuthError("response");
    const session = await this.refresh(
      {
        ...device,
        token: member.data.authTkn,
        appCode: "MIC",
        appVer: "2.7.1",
        osKnd: "A",
      },
      member.data.moappMbrsSno,
    );
    return { session, moappMbrsSno: member.data.moappMbrsSno };
  }

  async refresh(session: GoSession, moappMbrsSno: string): Promise<GoSession> {
    const parsed = GoSessionSchema.safeParse(session);
    if (!parsed.success) throw new GoAuthError("configuration");
    const auth = parsed.data;
    const device = { uuid: auth.uuid, osVer: auth.osVer };
    const body = createGoRefreshBody({
      device,
      memberSerial: moappMbrsSno,
      salt: this.#salt,
      now: this.#now(),
    });
    const data = await this.#post("api/mbrs/v2/uptMbrsAuthTknInfo", device, body, auth.token);
    const refreshed = z.object({ authTkn: tokenSchema }).safeParse(data);
    if (!refreshed.success) throw new GoAuthError("response");
    return { ...auth, token: refreshed.data.authTkn };
  }

  async #postToss(endpoint: "auth" | "authResult", device: GoDevice, body: unknown) {
    const data = await this.#post(`api/mbrs/auth/v2/toss/${endpoint}`, device, body);
    const parsed = tossEnvelopeSchema.safeParse(data);
    if (!parsed.success) throw new GoAuthError("response");
    if (parsed.data.rspCd !== "0000") throw new GoAuthError("authentication_required");
    return parsed.data.data;
  }

  async #post(path: string, device: GoDevice, body: unknown, token?: string) {
    const parsedDevice = GoDeviceSchema.safeParse(device);
    if (!parsedDevice.success) throw new GoAuthError("configuration");
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await this.#http.post(`https://tiaapi.tmoney.co.kr:20328/${path}`, {
        signal,
        headers: {
          ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
          appCode: "MIC",
          UUID: parsedDevice.data.uuid,
          appVer: "2.7.1",
          osKnd: "A",
          osVer: parsedDevice.data.osVer,
        },
        json: body,
      });
      const data: unknown = await response.json();
      const parsed = outerSchema.safeParse(data);
      if (!parsed.success) throw new GoAuthError("response");
      return parsed.data.dta;
    } catch (error) {
      if (error instanceof GoAuthError) throw new GoAuthError(error.code);
      if (error instanceof TimeoutError || signal.aborted) throw new GoAuthError("timeout");
      if (error instanceof HTTPError) {
        throw new GoAuthError(
          error.response.status === 401 || error.response.status === 403
            ? "authentication_required"
            : "http",
        );
      }
      if (error instanceof SyntaxError) throw new GoAuthError("response");
      // Errors at this credential boundary must not retain requests, responses, or causes.
      throw new GoAuthError("network");
    }
  }
}
