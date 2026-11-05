import { BookingAttempt } from "./booking-attempt";
import {
  BookingGateError,
  type BookingServices,
  bookingContext,
  bookingDeparture,
  bookingGate,
  localBookingIp,
} from "./booking-context";
import type { BookingStore } from "./booking-store";
import {
  type BookingCredentialAdapter,
  BookingError,
  type BookingRecord,
  type BookingSpec,
  BookingSpecSchema,
  bookingBinding,
} from "./booking-types";
import { TmoneyGoBusClient } from "./go-bus";
import { GO_MAX_SEAT_NUMBER } from "./go-bus-fares";
import { GoBusError } from "./go-bus-types";
import { TmoneyGoPurchaseClient } from "./go-purchase";
import type { Trip } from "./provider";
import type { TripQueryService } from "./query";
import { DEFAULT_SERVICE_LIMITS, type ServiceLimits } from "./service-limits";

export type BookingRunnerOptions = {
  readonly limits?: ServiceLimits;
  readonly store: BookingStore;
  readonly query: Pick<TripQueryService, "scan">;
  readonly credentials: BookingCredentialAdapter;
  readonly bus?: BookingServices["bus"];
  readonly purchase?: BookingServices["purchase"];
  readonly now?: () => number;
  readonly ipAddress?: () => string;
};

export class BookingRunner {
  readonly #services: BookingServices;
  readonly #attempt: BookingAttempt;
  readonly #query: Pick<TripQueryService, "scan">;
  readonly #limits: ServiceLimits;
  #pending: Promise<void> | undefined;
  readonly #exactAttempts = new Set<Promise<void>>();

  constructor(options: BookingRunnerOptions) {
    this.#query = options.query;
    this.#limits = options.limits ?? DEFAULT_SERVICE_LIMITS;
    this.#services = {
      store: options.store,
      credentials: options.credentials,
      bus: options.bus ?? new TmoneyGoBusClient(),
      purchase: options.purchase ?? new TmoneyGoPurchaseClient(),
      now: options.now ?? Date.now,
      ipAddress: options.ipAddress ?? localBookingIp,
    };
    this.#attempt = new BookingAttempt(this.#services);
    options.store.recover();
  }

  async create(input: BookingSpec, exactTrip?: Trip) {
    const parsed = BookingSpecSchema.safeParse(input);
    if (!parsed.success) throw new BookingError("invalid_spec");
    try {
      const credentials = await this.#services.credentials.read();
      return this.#services.store.create(parsed.data, bookingBinding(credentials), exactTrip);
    } catch (error) {
      if (error instanceof BookingError) throw error;
      throw new BookingError("configuration");
    }
  }

  async createExact(input: BookingSpec, trip: Trip) {
    const spec = BookingSpecSchema.parse(input);
    if (
      trip.service !== spec.criteria.service ||
      trip.adultCount !== spec.criteria.passengers.adults ||
      trip.studentCount !== spec.criteria.passengers.students ||
      trip.childCount !== spec.criteria.passengers.children ||
      trip.departureId !== spec.criteria.departureId ||
      trip.arrivalId !== spec.criteria.arrivalId ||
      trip.departureDate !== spec.criteria.date.replaceAll("-", "")
    )
      throw new BookingError("invalid_reference");
    const result = await this.create(spec, trip);
    if (!result.created) return result;
    const record = this.#services.store.read(result.booking.id);
    if (!record) throw new BookingError("configuration");
    const attempt = this.#watch(record);
    this.#exactAttempts.add(attempt);
    try {
      await attempt;
    } finally {
      this.#exactAttempts.delete(attempt);
    }
    const booking = this.#services.store.get(record.id);
    if (!booking) throw new BookingError("configuration");
    return { created: true, booking };
  }

  whenIdle(): Promise<void> {
    return Promise.all([this.#pending, ...this.#exactAttempts]).then(() => undefined);
  }
  async tick(): Promise<{ readonly checked: number; readonly skippedOverlap: boolean }> {
    if (this.#pending) return { checked: 0, skippedOverlap: true };
    const completion = Promise.withResolvers<void>();
    this.#pending = completion.promise;
    let checked = 0;
    try {
      for (const record of this.#services.store.due()) {
        if (record.stage === "watching") await this.#watch(record);
        else await this.#attempt.reconcile(record);
        checked++;
      }
      return { checked, skippedOverlap: false };
    } finally {
      this.#pending = undefined;
      completion.resolve();
    }
  }

  async #watch(record: BookingRecord) {
    const spec = record.spec;
    if (spec.version !== 2) {
      this.#services.store.transition(record, "cancelled", {
        lastError: "reauthorization_required",
      });
      return;
    }
    if (Date.parse(record.spec.expiresAt) <= this.#services.now()) {
      this.#services.store.transition(record, "expired", { lastError: "deadline" });
      return;
    }
    try {
      await bookingGate(this.#services, record, true);
      const scan = record.exactTrip
        ? { matches: [{ trip: record.exactTrip }], complete: true }
        : await this.#query.scan(spec.criteria);
      const matches = scan.matches.filter(
        ({ trip }) =>
          trip.service === spec.criteria.service &&
          trip.departureId === spec.criteria.departureId &&
          trip.arrivalId === spec.criteria.arrivalId &&
          trip.departureDate === spec.criteria.date.replaceAll("-", "") &&
          trip.totalFareKrw !== null &&
          trip.totalFareKrw > 0 &&
          trip.totalFareKrw <= spec.criteria.maxFareKrw &&
          bookingDeparture(trip.departureDate, trip.departureTime) > this.#services.now(),
      );
      if (!matches.length) {
        this.#wait(record, scan.complete ? null : "query");
        return;
      }
      const credentials = await this.#services.credentials.refresh();
      if (bookingBinding(credentials) !== record.bindingHash)
        throw new BookingGateError("account_changed");
      const context = bookingContext(credentials, this.#services.ipAddress());
      for (const { trip } of matches.slice(0, this.#limits.bookingCandidates)) {
        try {
          const selected = await this.#services.bus.findTrip(context, trip);
          if (
            selected.expectedTotalFareKrw === undefined ||
            selected.expectedTotalFareKrw !== trip.totalFareKrw ||
            selected.expectedTotalFareKrw > spec.criteria.maxFareKrw
          )
            continue;
          const seatMap = await this.#services.bus.readSeats(context, selected);
          const eligible = seatMap.selectableSeats
            .filter((seat) => seat >= 1 && seat <= GO_MAX_SEAT_NUMBER)
            .sort((a, b) => a - b);
          const policy = spec.seatPolicy;
          const assignments =
            policy.mode === "only"
              ? policy.seats
              : policy.passengerOrder.map((passengerType, index) => ({
                  passengerType,
                  seat: (policy.order === "ascending" ? eligible : eligible.toReversed())[index],
                }));
          if (
            assignments.some(
              (assignment) => assignment.seat === undefined || !eligible.includes(assignment.seat),
            )
          )
            continue;
          const seats = assignments.flatMap((assignment) =>
            assignment.seat === undefined
              ? []
              : [{ seat: assignment.seat, passengerType: assignment.passengerType }],
          );
          const [firstSeat, ...remainingSeats] = seats;
          if (!firstSeat) continue;
          await this.#attempt.run(record, {
            trip: selected,
            fareKrw: selected.expectedTotalFareKrw,
            seats: [firstSeat, ...remainingSeats],
            departureName: trip.departureName,
            arrivalName: trip.arrivalName,
          });
          return;
        } catch (error) {
          if (
            error instanceof GoBusError &&
            ["trip_match", "fare_changed", "seat_unavailable"].includes(error.code)
          )
            continue;
          throw error;
        }
      }
      this.#wait(record, "trip_unavailable");
    } catch (error) {
      if (error instanceof BookingGateError) {
        this.#services.store.transition(
          record,
          error.code === "deadline" || error.code === "departure_passed" ? "expired" : "failed",
          { lastError: error.code },
        );
      } else this.#wait(record, "query");
    }
  }

  #wait(record: BookingRecord, lastError: "query" | "trip_unavailable" | null) {
    if (record.exactTrip) {
      this.#services.store.transition(record, "failed", {
        lastError: lastError ?? "trip_unavailable",
        checkCount: record.checkCount + 1,
      });
      return;
    }
    this.#services.store.transition(record, "watching", {
      checkCount: record.checkCount + 1,
      lastError,
      nextCheckAt: Math.min(
        Date.parse(record.spec.expiresAt),
        this.#services.now() + record.spec.intervalSeconds * 1000,
      ),
    });
  }
}
