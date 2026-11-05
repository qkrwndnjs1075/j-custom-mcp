import { load } from "cheerio";
import { z } from "zod";
import type { TripSearch } from "./bus-provider";
import {
  ExpressTripSchema,
  ProviderError,
  parseProviderValue,
  type Trip,
  type TripPage,
  type UnavailableTrip,
} from "./provider-types";

export const ExpressRoutesSchema = z.object({
  rotInfList: z
    .array(
      z
        .object({
          deprCd: z
            .string()
            .regex(/^\d{3}$/)
            .brand("TerminalId"),
          arvlCd: z
            .string()
            .regex(/^\d{3}$/)
            .brand("TerminalId"),
          deprNm: z.string().min(1),
          arvlNm: z.string().min(1),
          deprArea: z.string(),
          arvlArea: z.string(),
          takeTime: z.string().regex(/^\d+$/).transform(Number),
        })
        .readonly(),
    )
    .readonly(),
});
export type ExpressRoute = z.infer<typeof ExpressRoutesSchema>["rotInfList"][number];
const actionSchema = z.tuple([
  z.string().regex(/^\d{8}$/),
  z.string().regex(/^\d{6}$/),
  z.string().regex(/^\d{6}$/),
  z.string().regex(/^\d{3}$/),
  z.string().regex(/^\d{3}$/),
  z.string().regex(/^\d+$/),
  z.string().regex(/^\d+$/),
  z.string().regex(/^\d+$/),
  z.enum(["Y", "N"]),
  z.enum(["Y", "N"]),
  z.string().regex(/^\d{3}$/),
  z.string().regex(/^\d{3}$/),
  z.enum(["Y", "N"]),
  z.enum(["Y", "N"]),
  z.enum(["Y", "N"]),
  z.enum(["Y", "N"]),
]);
export function parseExpressSchedule(
  html: string,
  context: { readonly search: TripSearch; readonly route: ExpressRoute },
): TripPage {
  const $ = load(html);
  const { search, route } = context;
  const searchDate = search.date.replaceAll("-", "");
  const searchTime = search.time.replace(":", "");
  for (const [name, expected] of [
    ["deprCd", search.departureId],
    ["arvlCd", search.arrivalId],
    ["deprDtm", searchDate],
  ]) {
    if ($(`input[name=${name}]`).attr("value") !== expected)
      throw new ProviderError("layout", "Express schedule does not match the requested route");
  }
  const rows = $("p[role=row]");
  if (!rows.length && !$(".bus_time").text().includes("조회되는 배차가 없습니다.")) {
    throw new ProviderError("layout", "Express provider did not return a recognized schedule");
  }
  const trips: Trip[] = [];
  const unavailable: UnavailableTrip[] = [];
  for (const row of rows.toArray()) {
    const element = $(row);
    const timeText = element.find(".start_time").text().replace(/\s/g, "");
    const time = `${parseProviderValue(z.string().regex(/^\d{2}:\d{2}$/), timeText).replace(":", "")}00`;
    const carrierName = element.find(".bus_com").text().trim();
    const busClassName = element.find(".grade").clone().children().remove().end().text().trim();
    if (!carrierName || !busClassName)
      throw new ProviderError("layout", "Express row lacks carrier or class");
    const remaining = parseProviderValue(
      z
        .string()
        .regex(/^\d+\s*석$/)
        .transform((value) => Number(value.replace(/\D/g, ""))),
      element.find(".remain").text().trim(),
    );
    const action = element.find("a[onclick]").attr("onclick");
    if (!action) {
      const status = element.find(".status").text().trim();
      if (remaining !== 0 || status !== "매진")
        throw new ProviderError("layout", "Unknown express unavailable row");
      if (time.slice(0, 4) >= searchTime)
        unavailable.push({
          service: "express",
          tripKey: null,
          departureTime: time,
          carrierName,
          busClassName,
          adultFareKrw: null,
          estimatedDurationMinutes: route.takeTime,
          availability: "sold_out",
          providerStatus: status,
        });
      continue;
    }
    const match = action.match(/^fnSatsChc\((('(?:[^'\\]*)',)*'[^'\\]*')\);?$/);
    if (!match?.[1]) throw new ProviderError("layout", "Unknown express selection action");
    const args = parseProviderValue(
      actionSchema,
      [...match[1].matchAll(/'([^']*)'/g)].map((part) => part[1]),
    );
    const [
      date,
      departureTime,
      scheduledDepartureTime,
      allocationDepartureId,
      allocationArrivalId,
      busClassId,
      carrierId,
      discountCode,
      webEligible,
      ,
      departureId,
      arrivalId,
      privateBusinessAccrual,
      childSafetySeats,
      ,
      accessibleSeats,
    ] = args;
    if (
      date !== searchDate ||
      departureTime !== time ||
      departureId !== search.departureId ||
      arrivalId !== search.arrivalId
    ) {
      throw new ProviderError(
        "layout",
        "Express selection identity differs from requested schedule",
      );
    }
    const trip = parseProviderValue(ExpressTripSchema, {
      service: "express",
      departureId,
      arrivalId,
      departureName: route.deprNm,
      arrivalName: route.arvlNm,
      departureDate: date,
      departureTime,
      scheduledDepartureTime,
      carrierId,
      carrierName,
      busClassId,
      busClassName,
      adultCount: search.passengers.adults,
      studentCount: search.passengers.students,
      childCount: search.passengers.children,
      remainingSeats: remaining,
      totalSeats: null,
      adultFareKrw: null,
      fareQuotes: { adults: null, students: null, children: null },
      estimatedDurationMinutes: route.takeTime,
      expressIdentity: {
        allocationDepartureId,
        allocationArrivalId,
        discountCode,
        webCheckoutEligible: webEligible === "Y",
        privateBusinessAccrual,
        childSafetySeats,
        accessibleSeats,
      },
    });
    if (time.slice(0, 4) >= searchTime) trips.push(trip);
  }
  return {
    trips,
    unavailable,
    continuation: null,
    coverage: "end",
    emptyStatus: rows.length ? "none" : "unknown_empty",
  };
}
