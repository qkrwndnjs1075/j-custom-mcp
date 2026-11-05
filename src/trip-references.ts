import { z } from "zod";
import type { Trip } from "./provider";
import { parseProviderValue, TripSchema } from "./provider-types";
import { DEFAULT_SERVICE_LIMITS, type ServiceLimits } from "./service-limits";
import type { StateStorage } from "./transient-state";

export class TripReferences {
  private readonly trips = new Map<string, { readonly trip: Trip; readonly expires: number }>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly limits: Pick<
      ServiceLimits,
      "tripReferences" | "tripReferenceTtlSeconds"
    > = DEFAULT_SERVICE_LIMITS,
    private readonly state?: StateStorage,
  ) {
    const value = state?.get("trips");
    if (value !== undefined) {
      const entries = z
        .array(
          z.tuple([
            z.string().uuid(),
            z.strictObject({ trip: TripSchema, expires: z.number().finite() }),
          ]),
        )
        .parse(value);
      for (const [key, entry] of entries)
        if (entry.expires > this.now()) this.trips.set(key, entry);
    }
  }

  private checkpoint(): void {
    this.state?.set("trips", [...this.trips]);
  }

  add(trip: Trip): string {
    const now = this.now();
    for (const [key, entry] of this.trips) {
      if (entry.expires <= now) this.trips.delete(key);
    }
    if (this.trips.size >= this.limits.tripReferences) {
      const oldest = this.trips.keys().next().value;
      if (oldest) this.trips.delete(oldest);
    }
    const reference = crypto.randomUUID();
    this.trips.set(reference, { trip, expires: now + this.limits.tripReferenceTtlSeconds * 1_000 });
    this.checkpoint();
    return reference;
  }

  get(reference: string): Trip | undefined {
    const entry = this.trips.get(reference);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) {
      this.trips.delete(reference);
      this.checkpoint();
      return undefined;
    }
    return entry.trip;
  }

  updateQuote(
    reference: string,
    quote: Pick<Trip, "adultFareKrw" | "fareQuotes" | "totalFareKrw" | "remainingSeats"> & {
      readonly totalSeats?: number | null;
    },
  ): boolean {
    const entry = this.trips.get(reference);
    if (!entry || entry.expires <= this.now()) return false;
    this.trips.set(reference, {
      trip: {
        ...parseProviderValue(TripSchema, { ...entry.trip, ...quote }),
        tripKey: entry.trip.tripKey,
      },
      expires: entry.expires,
    });
    this.checkpoint();
    return true;
  }
}

export type TripReferenceStore = Pick<TripReferences, "add" | "get" | "updateQuote">;

export function withPublicReferences(
  own: TripReferenceStore,
  shared: TripReferenceStore,
): TripReferenceStore {
  return {
    add: (trip) => own.add(trip),
    get: (reference) => own.get(reference) ?? shared.get(reference),
    updateQuote: (reference, quote) =>
      own.get(reference) ? own.updateQuote(reference, quote) : shared.updateQuote(reference, quote),
  };
}
