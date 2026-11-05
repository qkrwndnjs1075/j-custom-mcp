import { z } from "zod";
import { openBookingDatabase } from "./booking-database";
import {
  type Booking,
  BookingError,
  type BookingPatch,
  type BookingRecord,
  BookingRecordSchema,
  type BookingSpec,
  BookingSpecSchema,
  type BookingStage,
  bookingTransitions,
  publicBooking,
} from "./booking-types";
import type { Trip } from "./provider";
import { TripSchema } from "./provider-types";
import { DEFAULT_SERVICE_LIMITS, type ServiceLimits } from "./service-limits";
import type { SyncDatabase } from "./sql-database";

function decode(row: { readonly record: string }): BookingRecord {
  try {
    const raw: unknown = JSON.parse(row.record);
    const parsed = BookingRecordSchema.safeParse(raw);
    if (!parsed.success) throw new BookingError("configuration");
    return parsed.data;
  } catch (error) {
    if (error instanceof BookingError) throw error;
    throw new BookingError("configuration");
  }
}

export class BookingStore {
  readonly #db: SyncDatabase;
  readonly #now: () => number;

  constructor(
    path: string | SyncDatabase,
    accountId: string,
    now: () => number = Date.now,
    readonly limits: ServiceLimits = DEFAULT_SERVICE_LIMITS,
  ) {
    this.#now = now;
    try {
      this.#db = openBookingDatabase(path, accountId);
    } catch (error) {
      if (error instanceof BookingError) throw error;
      throw new BookingError("configuration");
    }
  }

  create(
    input: BookingSpec,
    bindingHash: string,
    exactTrip?: Trip,
  ): { readonly booking: Booking; readonly created: boolean } {
    const spec = BookingSpecSchema.safeParse(input);
    const selectedTrip = exactTrip ? TripSchema.parse(exactTrip) : undefined;
    if (
      !spec.success ||
      !z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .safeParse(bindingHash).success
    )
      throw new BookingError("invalid_spec");
    if (selectedTrip && selectedTrip.service !== spec.data.criteria.service)
      throw new BookingError("invalid_reference");
    if (
      spec.data.intervalSeconds < this.limits.minimumPollSeconds ||
      spec.data.intervalSeconds > this.limits.maximumPollSeconds
    )
      throw new BookingError("invalid_interval");
    return this.#db
      .transaction(() => {
        const duplicate = this.#db
          .query<{ readonly record: string }, [string]>(
            "SELECT record FROM bookings WHERE idempotency_key=?",
          )
          .get(spec.data.idempotencyKey);
        if (duplicate) {
          const record = decode(duplicate);
          if (
            record.bindingHash !== bindingHash ||
            JSON.stringify(record.spec) !== JSON.stringify(spec.data) ||
            JSON.stringify(record.exactTrip) !== JSON.stringify(selectedTrip)
          ) {
            throw new BookingError("duplicate_key");
          }
          return { booking: publicBooking(record), created: false };
        }
        const now = this.#now();
        if (Date.parse(spec.data.expiresAt) <= now) throw new BookingError("expired");
        const records = this.records();
        const active = records.filter(
          (record) => !["booked", "cancelled", "expired", "failed"].includes(record.stage),
        );
        if (
          records.length >= this.limits.retainedBookings ||
          active.length >= this.limits.activeBookings
        )
          throw new BookingError("capacity");
        const record: BookingRecord = {
          id: crypto.randomUUID(),
          spec: spec.data,
          ...(selectedTrip ? { exactTrip: selectedTrip } : {}),
          stage: "watching",
          bindingHash,
          revision: 0,
          createdAt: now,
          updatedAt: now,
          nextCheckAt: now,
          checkCount: 0,
          lastError: null,
          hold: null,
          selection: null,
          purchaseMonth: null,
          paymentOrderNumber: null,
          receiptBaseline: null,
          issueAttempted: false,
          releaseAccepted: null,
        };
        this.#db
          .query("INSERT INTO bookings VALUES (?,?,?,?,?,?)")
          .run(
            record.id,
            spec.data.idempotencyKey,
            record.stage,
            record.revision,
            now,
            JSON.stringify(record),
          );
        return { booking: publicBooking(record), created: true };
      })
      .immediate();
  }

  read(id: string): BookingRecord | undefined {
    const row = this.#db
      .query<{ readonly record: string }, [string]>("SELECT record FROM bookings WHERE id=?")
      .get(id);
    return row ? decode(row) : undefined;
  }
  records(): readonly BookingRecord[] {
    return this.#db
      .query<{ readonly record: string }, []>("SELECT record FROM bookings ORDER BY rowid")
      .all()
      .map(decode);
  }
  get(id: string): Booking | undefined {
    const record = this.read(id);
    return record ? publicBooking(record) : undefined;
  }
  list(): readonly Booking[] {
    return this.records().map(publicBooking);
  }

  transition(
    record: BookingRecord,
    stage: BookingStage,
    patch: BookingPatch = {},
  ): BookingRecord | undefined {
    if (!bookingTransitions[record.stage].includes(stage)) throw new BookingError("configuration");
    const parsed = BookingRecordSchema.safeParse({
      ...record,
      ...patch,
      stage,
      revision: record.revision + 1,
      updatedAt: this.#now(),
    });
    if (!parsed.success) throw new BookingError("configuration");
    const next = parsed.data;
    const result = this.#db
      .query(`UPDATE bookings SET stage=?,revision=?,next_check_at=?,record=?
      WHERE id=? AND stage=? AND revision=?`)
      .run(
        stage,
        next.revision,
        next.nextCheckAt,
        JSON.stringify(next),
        record.id,
        record.stage,
        record.revision,
      );
    return result.changes === 1 ? next : undefined;
  }

  cancel(id: string): { readonly cancelled: boolean; readonly booking: Booking | undefined } {
    const record = this.read(id);
    if (record?.stage !== "watching")
      return { cancelled: false, booking: record ? publicBooking(record) : undefined };
    const next = this.transition(
      record,
      Date.parse(record.spec.expiresAt) <= this.#now() ? "expired" : "cancelled",
    );
    return {
      cancelled: next?.stage === "cancelled",
      booking: next ? publicBooking(next) : this.get(id),
    };
  }

  due(): readonly BookingRecord[] {
    return this.records().filter(
      (record) =>
        record.nextCheckAt <= this.#now() &&
        (record.stage === "watching" ||
          record.stage === "reconciling" ||
          (record.stage === "uncertain" &&
            record.issueAttempted &&
            record.hold !== null &&
            record.purchaseMonth !== null)),
    );
  }

  recover(): void {
    for (const record of this.records()) {
      if (record.spec.version !== 2 && record.stage === "watching") {
        this.transition(record, "cancelled", { lastError: "reauthorization_required" });
      }
      if (["holding", "held", "reserving", "reserved", "issuing"].includes(record.stage)) {
        this.transition(record, "uncertain", {
          lastError: "reconciliation_pending",
          nextCheckAt: this.#now(),
        });
      }
    }
  }
  close(): void {
    this.#db.close();
  }
}
