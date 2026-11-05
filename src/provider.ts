import ky, { HTTPError, TimeoutError } from "ky";
import type { BusProvider, TerminalSearch, TripSearch } from "./bus-provider";
import { rejectProviderRedirect } from "./http-policy";
import { parseDispatch, parseSeats, parseTerminals } from "./provider-html";
import { nextContinuation, readContinuation } from "./provider-pagination";
import {
  createSeatForm,
  ProviderError,
  type SeatMap,
  type Terminal,
  type Trip,
  type TripPage,
} from "./provider-types";

export type { BusProvider, TerminalSearch, TripSearch } from "./bus-provider";
export type { SeatMap, Terminal, Trip, TripPage, UnavailableTrip } from "./provider-types";
export { ProviderError } from "./provider-types";

export class TmoneyIntercityClient implements BusProvider {
  private readonly http = ky.create({
    prefixUrl: "https://txbus.t-money.co.kr",
    headers: { "User-Agent": "Mozilla/5.0" },
    retry: 0,
    timeout: 30_000,
    redirect: "manual",
    hooks: { afterResponse: [rejectProviderRedirect] },
  });

  private async post(path: string, body: URLSearchParams): Promise<string> {
    try {
      const response = await this.http.post(path, { body });
      return await response.text();
    } catch (error) {
      if (error instanceof HTTPError) {
        await error.response.body?.cancel();
        throw new ProviderError("http", `Provider returned HTTP ${error.response.status}`, {
          cause: error,
        });
      }
      if (error instanceof TimeoutError) {
        throw new ProviderError("timeout", "Provider request timed out", { cause: error });
      }
      if (error instanceof TypeError) {
        throw new ProviderError("network", "Provider connection failed", { cause: error });
      }
      throw error;
    }
  }

  async searchTerminals(search: TerminalSearch): Promise<readonly Terminal[]> {
    if (search.service !== "intercity")
      throw new ProviderError("unavailable", "Expected intercity service");
    const response = await this.post(
      "otck/readTrmlList.do",
      new URLSearchParams({
        cty_Bus_Area_Cd: "",
        trml_Nm: search.query,
        pre_Trml_Cd: search.departureId ?? "",
        rtnGbn: search.departureId ? "02" : "01",
      }),
    );
    try {
      const data: unknown = JSON.parse(response);
      return parseTerminals(data);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ProviderError("layout", "Provider did not return terminal JSON", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async searchTripPage(search: TripSearch): Promise<TripPage> {
    if (search.service !== "intercity")
      throw new ProviderError("unavailable", "Expected intercity service");
    const continuationBody = readContinuation(search);
    if (continuationBody) {
      return this.dispatchPage(continuationBody, search);
    }
    const [departures, arrivals] = await Promise.all([
      this.searchTerminals({ service: "intercity", query: "" }),
      this.searchTerminals({ service: "intercity", query: "", departureId: search.departureId }),
    ]);
    const departure = departures.find((terminal) => terminal.id === search.departureId);
    const arrival = arrivals.find((terminal) => terminal.id === search.arrivalId);
    if (!departure || !arrival) {
      throw new ProviderError("unavailable", "Selected terminals are not available on this route");
    }
    return this.dispatchPage(
      new URLSearchParams({
        depr_Trml_Cd: search.departureId,
        arvl_Trml_Cd: search.arrivalId,
        depr_Trml_Nm: departure.name,
        arvl_Trml_Nm: arrival.name,
        depr_Dt: search.date,
        depr_Time: search.time,
        ig: String(search.passengers.adults),
        im: String(search.passengers.students),
        ic: String(search.passengers.children),
        iv: "0",
        bef_Aft_Dvs: "D",
        req_Rec_Num: "10",
      }),
      search,
    );
  }

  private async dispatchPage(body: URLSearchParams, search: TripSearch): Promise<TripPage> {
    const response = await this.post("otck/readAlcnList.do", body);
    const continuation = nextContinuation(response, search);
    const page = parseDispatch(response);
    if (
      page.trips.some(
        (trip) =>
          trip.adultCount !== search.passengers.adults ||
          trip.studentCount !== search.passengers.students ||
          trip.childCount !== search.passengers.children,
      )
    ) {
      throw new ProviderError("layout", "Provider changed passenger composition");
    }
    return { ...page, continuation, coverage: continuation ? "more" : "end" };
  }

  async getSeats(trip: Trip): Promise<SeatMap> {
    if (trip.service !== "intercity")
      throw new ProviderError("unavailable", "Expected intercity trip");
    return parseSeats(await this.post("otck/readSatsFee.do", createSeatForm(trip)));
  }
}
