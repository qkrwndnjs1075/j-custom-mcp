import ky, { HTTPError, TimeoutError } from "ky";
import { z } from "zod";
import {
  type GoBusContext,
  GoBusContextSchema,
  GoBusError,
  goBusAliases,
  parseGoBusValue,
} from "./go-bus-types";
import { rejectProviderRedirect } from "./http-policy";

const businessAliases = { errCode: ["err_cod", "ERR_COD", "errCod"] } as const;
const endpointSchema = z.enum([
  "user/getUsrSno.do",
  "user/selectMyPagePayList.do",
  "user/selectMyPagePayListSecu.do",
  "user/selectMyPagePayInfo2.do",
  "ticket/selectCanTckList.do",
  "ticket/selectFeeInfo.do",
  "ticket/insertTckCanCad2.do",
  "ticket/tckResponse.do",
  "common/selectloadingInfo.do",
  "common/selectBasicInfo.do",
  "ticket/selectIbtList2.do",
  "ticket/selectIbtInfo.do",
  "ticket/updatepcpysats.do",
  "ticket/insertTckCad_CR.do",
  "ticket/selectTckRstStat.do",
  "ticket/selectBuyTckInfo2.do",
  "ticket/selectBuyTckInfoList2.do",
  "ticket/selectTimInfo2.do",
  "ticket/selectArrInfo.do",
  "ticket/insertPcpyNo.do",
  "ticket/deletePcpyNo.do",
  "ticket/selectBuyTckListSecu.do",
]);

export class GoBusHttp {
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
    if (!timeout.success) throw new GoBusError("configuration");
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
    request: {
      readonly path: z.infer<typeof endpointSchema>;
      readonly service?: "intercity" | "express";
      readonly body: Readonly<Record<string, string | number | Readonly<Record<string, string>>>>;
      readonly mutation?: "hold" | "release" | "purchase" | "cancellation" | "acknowledgement";
    },
  ): Promise<unknown> {
    const parsed = GoBusContextSchema.safeParse(context);
    if (!endpointSchema.safeParse(request.path).success) throw new GoBusError("input");
    if (!parsed.success || (request.path !== "user/getUsrSno.do" && !parsed.data.userNumber))
      throw new GoBusError("configuration");
    const { session, userNumber, osRelease, country, ipAddress } = parsed.data;
    const service = request.service ?? "intercity";
    const expressOnly = [
      "user/selectMyPagePayListSecu.do",
      "ticket/selectTimInfo2.do",
      "ticket/selectArrInfo.do",
      "ticket/insertPcpyNo.do",
      "ticket/deletePcpyNo.do",
      "ticket/selectBuyTckListSecu.do",
    ];
    const shared = [
      "user/selectMyPagePayInfo2.do",
      "ticket/selectCanTckList.do",
      "ticket/selectFeeInfo.do",
      "ticket/insertTckCanCad2.do",
      "ticket/tckResponse.do",
      "ticket/insertTckCad_CR.do",
      "ticket/selectTckRstStat.do",
      "ticket/selectBuyTckInfo2.do",
      "ticket/selectBuyTckInfoList2.do",
    ];
    let origin: string;
    let common: Readonly<Record<string, string>>;
    switch (service) {
      case "intercity":
        if (expressOnly.includes(request.path)) throw new GoBusError("input");
        origin = "https://icbusmob.tmoney.co.kr/tgx/tgoxzz/";
        common = {
          CUR_VER: "1729",
          HP_COD: "A",
          IP_ADDRESS: ipAddress,
          USR_SNO: userNumber,
          OS_VER: session.osVer,
        };
        break;
      case "express":
        if (!expressOnly.includes(request.path) && !shared.includes(request.path))
          throw new GoBusError("input");
        origin = request.path.startsWith("user/")
          ? "https://exp.tmoney.co.kr/tgm/tgoapp/"
          : "https://exp.tmoney.co.kr/tgm/tgoapp/k5/";
        common = {
          cur_ver: "1729",
          hp_cod: "A",
          ip_address: ipAddress,
          usr_sno: userNumber,
          os_ver: session.osVer,
        };
        break;
      default:
        throw new GoBusError("input");
    }
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      const response = await this.#http.post(`${origin}${request.path}`, {
        signal,
        headers: {
          Authorization: `Bearer ${session.token}`,
          JWT: session.token,
          UUID: session.uuid,
          "Device-Uuid": session.uuid,
          appCode: "MIC",
          "Tgo-Agent": `TGO/2.7.1(1729) ANDROID/${osRelease} ${country}`,
        },
        json: {
          ...request.body,
          ...common,
        },
      });
      const raw: unknown = await response.json();
      const result = goBusAliases(raw, businessAliases);
      const business = parseGoBusValue(z.object({ errCode: z.string() }), result);
      if (business.errCode !== "00000") throw new GoBusError("rejected");
      return result;
    } catch (error) {
      if (request.mutation === "cancellation") throw new GoBusError("cancellation_uncertain");
      if (request.mutation === "acknowledgement") throw new GoBusError("acknowledgement_uncertain");
      if (error instanceof GoBusError && error.code === "rejected")
        throw new GoBusError("rejected");
      if (request.mutation === "hold") throw new GoBusError("hold_uncertain");
      if (request.mutation === "release") throw new GoBusError("release_uncertain");
      if (request.mutation === "purchase") throw new GoBusError("purchase_uncertain");
      if (error instanceof GoBusError) throw new GoBusError(error.code);
      if (error instanceof TimeoutError || signal.aborted) throw new GoBusError("timeout");
      if (error instanceof HTTPError)
        throw new GoBusError(
          error.response.status === 401 || error.response.status === 403
            ? "authentication_required"
            : "rejected",
        );
      if (error instanceof SyntaxError) throw new GoBusError("response");
      throw new GoBusError("network");
    }
  }
}
