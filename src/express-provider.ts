import ky, { HTTPError, type Options, TimeoutError } from "ky";
import type { BusProvider, TerminalSearch, TripSearch } from "./bus-provider";
import { ExpressRoutesSchema, parseExpressSchedule } from "./express-provider-html";
import { parseExpressSeats } from "./express-provider-seats";
import { rejectProviderRedirect } from "./http-policy";
import {
  type ExpressTrip,
  ProviderError,
  parseProviderValue,
  type SeatMap,
  type Terminal,
  type Trip,
  type TripPage,
} from "./provider-types";

export function createExpressSeatForm(trip: ExpressTrip): URLSearchParams {
  const identity = trip.expressIdentity;
  return new URLSearchParams({
    deprCd: trip.departureId,
    arvlCd: trip.arrivalId,
    deprNm: trip.departureName,
    arvlNm: trip.arrivalName,
    pathDvs: "sngl",
    pathStep: "1",
    deprDtm: trip.departureDate,
    deprDtmOrg: trip.departureDate,
    busClsCd: "0",
    rtrpChc: "1",
    deprTime: trip.departureTime,
    alcnDeprTime: trip.scheduledDepartureTime,
    alcnDeprTrmlNo: identity.allocationDepartureId,
    alcnArvlTrmlNo: identity.allocationArrivalId,
    indVBusClsCd: trip.busClassId,
    cacmCd: trip.carrierId,
    dcDvsCd: identity.discountCode,
    prvtBbizEmpAcmtRt: identity.privateBusinessAccrual,
    chldSftySatsYn: identity.childSafetySeats,
    dsprSatsYn: identity.accessibleSeats,
  });
}
export class KobusExpressClient implements BusProvider {
  private readonly http;
  constructor(
    fetchImplementation: NonNullable<Options["fetch"]> = globalThis.fetch.bind(globalThis),
  ) {
    this.http = ky.create({
      prefixUrl: "https://www.kobus.co.kr",
      fetch: fetchImplementation,
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.kobus.co.kr/mrs/rotinf.do" },
      timeout: 30_000,
      retry: 0,
      redirect: "manual",
      hooks: { afterResponse: [rejectProviderRedirect] },
    });
  }
  private async post(path: string, body: URLSearchParams): Promise<string> {
    try {
      const response = await this.http.post(path, { body });
      return await response.text();
    } catch (error) {
      if (error instanceof HTTPError) {
        await error.response.body?.cancel();
        throw new ProviderError("http", `Express provider returned HTTP ${error.response.status}`, {
          cause: error,
        });
      }
      if (error instanceof TimeoutError)
        throw new ProviderError("timeout", "Express provider request timed out", { cause: error });
      if (error instanceof TypeError)
        throw new ProviderError("network", "Express provider connection failed", { cause: error });
      throw error;
    }
  }
  private async routes() {
    const response = await this.post("mrs/readRotLinInf.ajax", new URLSearchParams());
    try {
      return parseProviderValue(ExpressRoutesSchema, JSON.parse(response)).rotInfList;
    } catch (error) {
      if (error instanceof SyntaxError)
        throw new ProviderError("layout", "Express provider did not return route JSON", {
          cause: error,
        });
      throw error;
    }
  }
  async searchTerminals(search: TerminalSearch): Promise<readonly Terminal[]> {
    if (search.service !== "express")
      throw new ProviderError("unavailable", "Express provider requires express service");
    const routes = await this.routes();
    const terminals = new Map<string, Terminal>();
    for (const route of routes) {
      if (search.departureId && route.deprCd !== search.departureId) continue;
      const terminal = search.departureId
        ? {
            service: "express" as const,
            id: route.arvlCd,
            name: route.arvlNm,
            area: route.arvlArea,
          }
        : {
            service: "express" as const,
            id: route.deprCd,
            name: route.deprNm,
            area: route.deprArea,
          };
      if (terminal.name.includes(search.query.trim())) terminals.set(terminal.id, terminal);
    }
    return [...terminals.values()];
  }
  async searchTripPage(search: TripSearch): Promise<TripPage> {
    if (search.service !== "express" || search.continuation)
      throw new ProviderError(
        "unavailable",
        "Express query does not accept another service or continuation",
      );
    const route = (await this.routes()).find(
      (route) => route.deprCd === search.departureId && route.arvlCd === search.arrivalId,
    );
    if (!route) throw new ProviderError("unavailable", "Selected express route is unavailable");
    const html = await this.post(
      "mrs/alcnSrch.do",
      new URLSearchParams({
        deprCd: route.deprCd,
        arvlCd: route.arvlCd,
        deprNm: route.deprNm,
        arvlNm: route.arvlNm,
        pathDvs: "sngl",
        pathStep: "1",
        deprDtm: search.date.replaceAll("-", ""),
        busClsCd: "0",
        rtrpChc: "1",
      }),
    );
    return parseExpressSchedule(html, { search, route });
  }
  async getSeats(trip: Trip): Promise<SeatMap> {
    if (trip.service !== "express")
      throw new ProviderError("unavailable", "Express provider requires an express trip");
    return parseExpressSeats(await this.post("mrs/satschc.do", createExpressSeatForm(trip)), trip);
  }
}
