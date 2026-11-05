import type { BusProvider } from "./bus-provider";
import { passengerCount, totalFare } from "./passengers";
import {
  ProviderError,
  parseProviderValue,
  type SeatMap,
  type Trip,
  type TripPage,
  TripSchema,
} from "./provider-types";
import { findJourneys } from "./query-journeys";
import { adjacentWindows, compareTrips, minutes } from "./query-matching";
import type { JourneySearch, TripCriteria } from "./query-types";
import { DEFAULT_SERVICE_LIMITS, type ServiceLimits } from "./service-limits";

export type TripMatch = {
  readonly trip: Trip;
  readonly adjacentSeatGroups?: readonly (readonly number[])[];
};
export type TripScan = {
  readonly matches: readonly TripMatch[];
  readonly complete: boolean;
  readonly reasons: readonly string[];
};
export type Journey = { readonly legs: readonly TripMatch[]; readonly totalFareKrw: number };
export type JourneyResult = {
  readonly journeys: readonly Journey[];
  readonly complete: boolean;
  readonly reasons: readonly string[];
};

export class TripQueryService {
  constructor(
    private readonly provider: Pick<BusProvider, "searchTripPage" | "getSeats">,
    private readonly now: () => number = Date.now,
    private readonly limits: ServiceLimits = DEFAULT_SERVICE_LIMITS,
  ) {}

  async scan(criteria: TripCriteria): Promise<TripScan> {
    const reasons = new Set<string>();
    const matches: TripMatch[] = [];
    const seen = new Set<string>();
    const seenUnavailable = new Set<string>();
    const continuations = new Set<string>();
    let continuation: string | undefined;
    let seatChecks = 0;
    const deadline = this.now() + this.limits.queryTimeoutMs;
    for (let pageNumber = 0; pageNumber < this.limits.queryPages; pageNumber++) {
      if (this.now() >= deadline) {
        reasons.add("time_limit");
        break;
      }
      let page: TripPage;
      try {
        page = await this.provider.searchTripPage({
          service: criteria.service,
          departureId: criteria.departureId,
          arrivalId: criteria.arrivalId,
          date: criteria.date,
          time: criteria.time,
          passengers: criteria.passengers,
          ...(continuation === undefined ? {} : { continuation }),
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        reasons.add(`provider_${error.code}`);
        break;
      }
      if (page.emptyStatus === "unknown_empty") reasons.add("unknown_empty");
      if (page.unavailable.some((trip) => trip.availability === "unknown")) {
        reasons.add("unknown_availability");
      }
      let added = 0;
      for (const unavailable of page.unavailable) {
        const key = JSON.stringify(unavailable);
        if (!seenUnavailable.has(key)) {
          seenUnavailable.add(key);
          added++;
        }
      }
      for (const source of page.trips) {
        if (source.service !== criteria.service) {
          reasons.add("service_mismatch");
          continue;
        }
        if (
          source.adultCount !== criteria.passengers.adults ||
          source.studentCount !== criteria.passengers.students ||
          source.childCount !== criteria.passengers.children ||
          source.passengers.adults !== source.adultCount ||
          source.passengers.students !== source.studentCount ||
          source.passengers.children !== source.childCount
        ) {
          reasons.add("passenger_mismatch");
          continue;
        }
        const quotes = {
          ...source.fareQuotes,
          adults:
            source.adultFareKrw === null
              ? null
              : {
                  unitFareKrw: source.adultFareKrw,
                  fareKindCode: source.fareQuotes.adults?.fareKindCode ?? null,
                },
        };
        const trip = {
          ...source,
          fareQuotes: quotes,
          totalFareKrw: totalFare(criteria.passengers, quotes),
        };
        if (seen.has(trip.tripKey)) continue;
        seen.add(trip.tripKey);
        added++;
        const time = minutes(trip.departureTime);
        if (
          time < minutes(criteria.time) ||
          time > minutes(criteria.endTime) ||
          (criteria.departureTime !== undefined && time !== minutes(criteria.departureTime)) ||
          trip.remainingSeats <
            Math.max(
              criteria.minSeats,
              passengerCount(criteria.passengers),
              criteria.adjacentSeats ?? 1,
            )
        )
          continue;
        if (criteria.adjacentSeats === undefined && trip.totalFareKrw !== null) {
          if (criteria.maxFareKrw === undefined || trip.totalFareKrw <= criteria.maxFareKrw)
            matches.push({ trip });
          continue;
        }
        if (seatChecks >= this.limits.querySeatChecks || this.now() >= deadline) {
          reasons.add(
            seatChecks >= this.limits.querySeatChecks ? "seat_check_limit" : "time_limit",
          );
          continue;
        }
        seatChecks++;
        let map: SeatMap;
        try {
          map = await this.provider.getSeats(trip);
        } catch (error) {
          if (!(error instanceof ProviderError)) throw error;
          reasons.add(`seat_provider_${error.code}`);
          continue;
        }
        if (criteria.adjacentSeats !== undefined && map.layoutStatus !== "verified") {
          reasons.add("unknown_seat_layout");
          continue;
        }
        const selectedTotal = totalFare(criteria.passengers, map.fareQuotes);
        if (selectedTotal === null) {
          reasons.add("unknown_passenger_fare");
          continue;
        }
        const adjacentSeatGroups =
          criteria.adjacentSeats === undefined
            ? undefined
            : adjacentWindows(map, criteria.adjacentSeats);
        if (
          map.availableSeats >= Math.max(criteria.minSeats, passengerCount(criteria.passengers)) &&
          (adjacentSeatGroups === undefined || adjacentSeatGroups.length > 0) &&
          (criteria.maxFareKrw === undefined || selectedTotal <= criteria.maxFareKrw)
        ) {
          matches.push({
            trip: {
              ...parseProviderValue(TripSchema, {
                ...trip,
                adultFareKrw: map.adultFareKrw,
                fareQuotes: map.fareQuotes,
                totalFareKrw: selectedTotal,
                remainingSeats: map.availableSeats,
                totalSeats: map.totalSeats,
              }),
              tripKey: trip.tripKey,
            },
            ...(adjacentSeatGroups === undefined ? {} : { adjacentSeatGroups }),
          });
        }
      }
      if (page.coverage === "end") break;
      if (!page.continuation || continuations.has(page.continuation)) {
        reasons.add("pagination_stalled");
        break;
      }
      if (added === 0) {
        reasons.add("pagination_no_progress");
        break;
      }
      continuations.add(page.continuation);
      continuation = page.continuation;
      if (pageNumber === this.limits.queryPages - 1) reasons.add("page_limit");
    }
    matches.sort((a, b) => compareTrips(a.trip, b.trip, criteria));
    return { matches, complete: reasons.size === 0, reasons: [...reasons] };
  }

  findJourneys(input: JourneySearch): Promise<JourneyResult> {
    return findJourneys(input, (criteria) => this.scan(criteria), this.limits);
  }
}
