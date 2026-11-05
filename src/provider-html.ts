import { load } from "cheerio";
import { z } from "zod";
import {
  IntercityTripSchema,
  ProviderError,
  parseProviderValue,
  type Terminal,
  TerminalSchema,
  type Trip,
  tripFields,
  type UnavailableTrip,
} from "./provider-types";

export { parseSeats } from "./provider-seats";

export function parseTerminals(input: unknown): readonly Terminal[] {
  return parseProviderValue(z.array(TerminalSchema).readonly(), input);
}

export function parseTrips(html: string): readonly Trip[] {
  return parseDispatch(html).trips;
}

export function parseDispatch(html: string): {
  readonly trips: readonly Trip[];
  readonly unavailable: readonly UnavailableTrip[];
  readonly emptyStatus: "none" | "unknown_empty";
} {
  const $ = load(html);
  const table = $(".accordian_table.pc_ver");
  if ($("form#alcnList[action='/otck/readSatsFee.do']").length !== 1 || table.length !== 1) {
    throw new ProviderError("layout", "Provider did not return a dispatch page");
  }
  const rows = table.find("tbody > tr").not(".detail");
  const trips = new Map<string, Trip>();
  const unavailable: UnavailableTrip[] = [];
  for (const row of rows.toArray()) {
    const cells = $(row).children("td");
    if (cells.length === 1 && cells.text().trim() === "예매 가능한 내역이 없습니다.") {
      continue;
    }
    const duration = cells
      .eq(1)
      .text()
      .match(/(\d+):(\d{2})\s*소요 예상/);
    const estimatedDurationMinutes =
      duration?.[1] && duration[2] ? Number(duration[1]) * 60 + Number(duration[2]) : null;
    const fare = cells.eq(3).text().trim();
    const adultFareKrw = /^[\d,]+원$/.test(fare) ? Number(fare.replace(/[^\d]/g, "")) : null;
    const action = $(row).find("a[onclick^='readSasFeeInf(']").attr("onclick");
    const match = action?.match(/^readSasFeeInf\((.*)\);\s*return false;\s*$/);
    if (!match?.[1]) {
      const button = cells.last().find(".btn_reservation.disabled, .btn_soldout, .btn_noseat");
      const time = cells.eq(0).text().trim();
      const carrierName = cells.eq(1).find("strong").text().trim();
      const busClassName = cells.eq(2).text().trim();
      if (
        cells.length !== 7 ||
        button.length !== 1 ||
        button.attr("onclick") ||
        !/^\d{2}:\d{2}$/.test(time) ||
        !carrierName ||
        !busClassName
      ) {
        throw new ProviderError("layout", "Unrecognized dispatch row or availability state");
      }
      const providerStatus = button.text().replace(/\s+/g, " ").trim();
      unavailable.push({
        service: "intercity",
        tripKey: null,
        departureTime: `${time.replace(":", "")}00`,
        carrierName,
        busClassName,
        adultFareKrw,
        estimatedDurationMinutes,
        providerStatus,
        availability: /매진|^0석/.test(providerStatus)
          ? "sold_out"
          : /모바일예매가능|터미널 직접구매/.test(providerStatus)
            ? "unavailable"
            : "unknown",
      });
      continue;
    }
    const args = Array.from(match[1].matchAll(/'([^']*)'/g), (part) => part[1]);
    if (
      args.length !== tripFields.length ||
      match[1]
        .replace(/'[^']*'/g, "")
        .replaceAll(",", "")
        .trim() !== ""
    ) {
      throw new ProviderError("layout", "Unrecognized provider trip action");
    }
    if (adultFareKrw === null) {
      throw new ProviderError("layout", "Missing adult fare in dispatch row");
    }
    const trip = parseProviderValue(IntercityTripSchema, {
      service: "intercity",
      ...Object.fromEntries(tripFields.map(([key], index) => [key, args[index]])),
      adultFareKrw,
      estimatedDurationMinutes,
    });
    trips.set(trip.tripKey, trip);
  }
  if (rows.length === 0) {
    throw new ProviderError("layout", "Dispatch table has no recognized result rows");
  }
  return {
    trips: [...trips.values()],
    unavailable,
    emptyStatus: trips.size === 0 && unavailable.length === 0 ? "unknown_empty" : "none",
  };
}
