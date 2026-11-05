import ky, { TimeoutError } from "ky";
import { z } from "zod";
import { type GoBusContext, GoBusContextSchema } from "./go-bus-types";
import { GoPurchaseError, reserveFailureDiagnostic } from "./go-purchase-types";
import { rejectProviderRedirect } from "./http-policy";

type PurchasePath =
  | "api/pym/v2/inqrPymMnsListAtPym"
  | "api/pym/npay/v1/autoReserve"
  | "api/mbrs/v2/inqrMbrsBusUtlzList";

export class GoPurchaseHttp {
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
    if (!timeout.success) throw new GoPurchaseError("configuration");
    this.#timeoutMs = timeout.data;
    this.#http = ky.create({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      timeout: timeout.data,
      retry: 0,
      redirect: "manual",
      hooks: { afterResponse: [rejectProviderRedirect] },
    });
  }

  async post(
    context: GoBusContext,
    path: PurchasePath,
    body: Readonly<Record<string, string | number>>,
  ) {
    return (await this.postWithStatus(context, path, body)).data;
  }

  async postWithStatus(
    context: GoBusContext,
    path: PurchasePath,
    body: Readonly<Record<string, string | number>>,
  ): Promise<{ readonly data: unknown; readonly status: number }> {
    const parsed = GoBusContextSchema.safeParse(context);
    if (!parsed.success) throw new GoPurchaseError("configuration");
    const { session } = parsed.data;
    const reserving = path === "api/pym/npay/v1/autoReserve";
    const signal = AbortSignal.timeout(this.#timeoutMs);
    let status: number | undefined;
    try {
      const response = await this.#http.post(`https://tiaapi.tmoney.co.kr:20328/${path}`, {
        signal,
        throwHttpErrors: !reserving,
        headers: {
          Authorization: `Bearer ${session.token}`,
          appCode: session.appCode,
          UUID: session.uuid,
          appVer: session.appVer,
          osKnd: session.osKnd,
          osVer: session.osVer,
        },
        json: body,
      });
      status = response.status;
      const raw: unknown = await response.json();
      if (!response.ok)
        throw new GoPurchaseError(
          reserving ? "reserve_uncertain" : "network",
          reserving ? reserveFailureDiagnostic(raw, status, "http") : undefined,
        );
      return { data: raw, status };
    } catch (error) {
      if (error instanceof GoPurchaseError) throw new GoPurchaseError(error.code, error.diagnostic);
      throw new GoPurchaseError(
        reserving ? "reserve_uncertain" : "network",
        reserving
          ? reserveFailureDiagnostic(
              undefined,
              status,
              status !== undefined && (status < 200 || status >= 300)
                ? "http"
                : error instanceof TimeoutError || signal.aborted
                  ? "timeout"
                  : error instanceof SyntaxError
                    ? "invalid_json"
                    : "transport",
            )
          : undefined,
      );
    }
  }
}
