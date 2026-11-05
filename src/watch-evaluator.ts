import { officialCheckout } from "./checkout-target";
import type { TripQueryService } from "./query";
import type { Observation, WatchCriteria, WatchSpec } from "./watch-types";

export async function evaluateWatch(
  query: TripQueryService,
  criteria: WatchCriteria,
  mode: WatchSpec["mode"],
): Promise<Observation> {
  const result = await query.scan(criteria);
  let eligible = result.matches;
  switch (mode) {
    case "seats_available":
      break;
    case "booking_available":
      eligible = eligible.filter(({ trip }) => officialCheckout(trip) !== null);
      break;
    default:
      throw new TypeError(`Unknown watch mode: ${mode satisfies never}`);
  }
  const matches = eligible.flatMap(({ trip }) =>
    trip.totalFareKrw === null
      ? []
      : [
          {
            service: trip.service,
            passengers: criteria.passengers,
            fareQuotes: trip.fareQuotes,
            totalFareKrw: trip.totalFareKrw,
            tripKey: trip.tripKey,
            departureDate: trip.departureDate,
            departureTime: trip.departureTime,
            departureName: trip.departureName,
            arrivalName: trip.arrivalName,
            adultFareKrw: trip.adultFareKrw,
            remainingSeats: trip.remainingSeats,
          },
        ],
  );
  if (matches.length > 0) return { kind: "matched", matches };
  if (result.complete) return { kind: "not_matched" };
  const failed = result.reasons.some(
    (reason) => reason.startsWith("provider_") || reason.startsWith("seat_provider_"),
  );
  return { kind: failed ? "unknown" : "inconclusive", reason: result.reasons.join(", ") };
}
