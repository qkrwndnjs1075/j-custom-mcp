import { ProviderError, type SeatMap, type Trip } from "./provider-types";
import type { Journey } from "./query";
import type { JourneySearch, TripCriteria } from "./query-types";

export function minutes(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.replace(":", "").slice(2, 4));
}

function preference(trip: Trip, criteria: TripCriteria): number {
  return criteria.preferredTime
    ? Math.abs(minutes(trip.departureTime) - minutes(criteria.preferredTime))
    : 0;
}

export function adjacentWindows(map: SeatMap, count: number): readonly (readonly number[])[] {
  const available = new Set(map.seats.filter((seat) => seat.available).map((seat) => seat.number));
  const windows = new Map<string, readonly number[]>();
  for (const group of map.adjacentGroups) {
    for (let start = 0; start + count <= group.length; start++) {
      const window = group.slice(start, start + count);
      if (new Set(window).size === count && window.every((seat) => available.has(seat))) {
        windows.set(window.join(","), window);
      }
    }
  }
  return [...windows.values()];
}

export function departureMillis(trip: Trip): number {
  const date = trip.departureDate;
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(4, 6)) - 1,
    Number(date.slice(6, 8)),
    Number(trip.departureTime.slice(0, 2)),
    Number(trip.departureTime.slice(2, 4)),
    Number(trip.departureTime.slice(4, 6)),
  );
}

export function compareTrips(a: Trip, b: Trip, criteria: TripCriteria): number {
  for (const key of criteria.ranking) {
    let difference: number;
    switch (key) {
      case "preferred_time":
        difference = preference(a, criteria) - preference(b, criteria);
        break;
      case "fare":
        if (a.totalFareKrw === null || b.totalFareKrw === null)
          throw new ProviderError("layout", "Cannot rank an unquoted fare");
        difference = a.totalFareKrw - b.totalFareKrw;
        break;
      case "departure_time":
        difference = a.departureTime.localeCompare(b.departureTime);
        break;
    }
    if (difference !== 0) return difference;
  }
  return 0;
}

function journeyPreference(journey: Journey, input: JourneySearch): number {
  return journey.legs.reduce((sum, match, index) => {
    const criteria = input.legs[index];
    if (!criteria) throw new ProviderError("layout", "Journey does not match its requested legs");
    return sum + preference(match.trip, criteria);
  }, 0);
}

export function compareJourneys(a: Journey, b: Journey, input: JourneySearch): number {
  for (const key of input.ranking) {
    let difference = 0;
    switch (key) {
      case "total_fare":
        difference = a.totalFareKrw - b.totalFareKrw;
        break;
      case "total_preferred_time":
        difference = journeyPreference(a, input) - journeyPreference(b, input);
        break;
      case "leg_order":
        for (const [index, criteria] of input.legs.entries()) {
          const left = a.legs[index];
          const right = b.legs[index];
          if (!left || !right)
            throw new ProviderError("layout", "Journey does not match its requested legs");
          difference = compareTrips(left.trip, right.trip, criteria);
          if (difference !== 0) break;
        }
        break;
    }
    if (difference !== 0) return difference;
  }
  return 0;
}
