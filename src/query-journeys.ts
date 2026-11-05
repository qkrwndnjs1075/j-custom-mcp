import { ProviderError } from "./provider-types";
import type { Journey, JourneyResult, TripScan } from "./query";
import { compareJourneys, departureMillis } from "./query-matching";
import type { JourneySearch, TripCriteria } from "./query-types";
import type { ServiceLimits } from "./service-limits";

export async function findJourneys(
  input: JourneySearch,
  scanTrips: (criteria: TripCriteria) => Promise<TripScan>,
  limits: ServiceLimits,
): Promise<JourneyResult> {
  if (input.legs.length > limits.journeyLegs || input.maxResults > limits.journeyResults) {
    throw new ProviderError("unavailable", "Journey request exceeds configured service limits");
  }
  const reasons = new Set<string>();
  let candidates: Journey[] = [{ legs: [], totalFareKrw: 0 }];
  for (const criteria of input.legs) {
    const scan = await scanTrips(criteria);
    for (const reason of scan.reasons) reasons.add(reason);
    const next: Journey[] = [];
    let combinations = 0;
    combinationsLoop: for (const candidate of candidates) {
      for (const match of scan.matches) {
        if (combinations >= limits.journeyCombinations) {
          reasons.add("combination_limit");
          break combinationsLoop;
        }
        combinations++;
        const previous = candidate.legs.at(-1)?.trip;
        if (previous) {
          if (previous.service !== match.trip.service) {
            reasons.add("cross_service_transfer_unverified");
            continue;
          }
          if (previous.arrivalId !== match.trip.departureId) continue;
          if (departureMillis(match.trip) < departureMillis(previous)) continue;
          if (previous.estimatedDurationMinutes === null) {
            reasons.add("unknown_connection_duration");
            continue;
          }
          if (
            departureMillis(match.trip) <
            departureMillis(previous) + previous.estimatedDurationMinutes * 60_000
          )
            continue;
        }
        if (match.trip.totalFareKrw === null) continue;
        const totalFareKrw = candidate.totalFareKrw + match.trip.totalFareKrw;
        if (!Number.isSafeInteger(totalFareKrw)) {
          reasons.add("fare_overflow");
          continue;
        }
        if (input.maxTotalFareKrw !== undefined && totalFareKrw > input.maxTotalFareKrw) continue;
        next.push({ legs: [...candidate.legs, match], totalFareKrw });
      }
    }
    candidates = next;
  }
  candidates.sort((a, b) => compareJourneys(a, b, input));
  if (candidates.length > input.maxResults) reasons.add("max_results");
  return {
    journeys: candidates.slice(0, input.maxResults),
    complete: reasons.size === 0,
    reasons: [...reasons],
  };
}
