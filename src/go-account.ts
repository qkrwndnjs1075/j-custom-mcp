import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import { type BusService, BusServiceSchema } from "./bus-service";
import {
  type GoPaymentMethodStatus,
  GoPaymentResponseSchema,
  summarizeGoPayments,
} from "./go-payment-methods";
import { rejectProviderRedirect } from "./http-policy";

export type { GoPaymentMethod, GoPaymentMethodStatus } from "./go-payment-methods";

const headerValue = z
  .string()
  .min(1)
  .regex(/^[\x20-\x7e]+$/)
  .refine((value) => value.trim() === value);

export const GoSessionSchema = z
  .object({
    token: headerValue,
    appCode: headerValue,
    uuid: headerValue,
    appVer: headerValue,
    osKnd: headerValue,
    osVer: headerValue,
  })
  .readonly();
export type GoSession = z.infer<typeof GoSessionSchema>;

const messages = {
  authentication_required: "Tmoney GO authentication is required.",
  http: "Tmoney GO rejected the account inquiry.",
  timeout: "Tmoney GO account inquiry timed out.",
  network: "Tmoney GO account inquiry could not connect.",
  response: "Tmoney GO returned an unsupported account response.",
  configuration: "Tmoney GO account configuration is invalid.",
} as const;

export class GoAccountError extends Error {
  override readonly name = "GoAccountError";
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}

export type GoPaymentStatus = {
  readonly connection: "connected";
  readonly naverPay: Omit<GoPaymentMethodStatus, "method">;
  readonly paymentMethods: readonly GoPaymentMethodStatus[];
};

export class TmoneyGoAccountClient {
  readonly #http;
  readonly #timeoutMs: number;

  constructor(
    options: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number } = {},
  ) {
    const timeout = z
      .number()
      .int()
      .positive()
      .max(2_147_483_647)
      .safeParse(options.timeoutMs ?? 10_000);
    if (!timeout.success) throw new GoAccountError("configuration");
    this.#timeoutMs = timeout.data;
    this.#http = ky.create({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      timeout: this.#timeoutMs,
      retry: 0,
      redirect: "manual",
      hooks: { afterResponse: [rejectProviderRedirect] },
    });
  }

  async readPaymentStatus(session: GoSession, service: BusService): Promise<GoPaymentStatus> {
    const parsedSession = GoSessionSchema.safeParse(session);
    if (!parsedSession.success || !BusServiceSchema.safeParse(service).success)
      throw new GoAccountError("configuration");
    const auth = parsedSession.data;
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await this.#http.post(
        "https://tiaapi.tmoney.co.kr:20328/api/pym/v2/inqrPymMnsListAtPym",
        {
          signal,
          headers: {
            Authorization: `Bearer ${auth.token}`,
            appCode: auth.appCode,
            UUID: auth.uuid,
            appVer: auth.appVer,
            osKnd: auth.osKnd,
            osVer: auth.osVer,
          },
          json: { utlzSvcDvsCd: serviceCode(service) },
        },
      );
      const body: unknown = await response.json();
      const parsed = GoPaymentResponseSchema.safeParse(body);
      if (!parsed.success) throw new GoAccountError("response");
      return {
        connection: "connected",
        ...summarizeGoPayments(parsed.data.dta),
      };
    } catch (error) {
      if (error instanceof GoAccountError) throw new GoAccountError(error.code);
      if (error instanceof TimeoutError || signal.aborted) throw new GoAccountError("timeout");
      if (error instanceof HTTPError) {
        throw new GoAccountError(
          error.response.status === 401 || error.response.status === 403
            ? "authentication_required"
            : "http",
        );
      }
      if (error instanceof SyntaxError) throw new GoAccountError("response");
      // This credential boundary must never expose fetch errors, requests, responses, or causes.
      throw new GoAccountError("network");
    }
  }
}

function serviceCode(service: BusService): "C" | "H" {
  switch (service) {
    case "intercity":
      return "C";
    case "express":
      return "H";
  }
}
