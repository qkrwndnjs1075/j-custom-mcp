import { afterEach, expect, test } from "bun:test";
import { BookingError, BookingRecordSchema, BookingSpecSchema } from "../src/booking-types";
import { TripSchema } from "../src/provider-types";
import { WatchMatchSchema, WatchSpecSchema } from "../src/watch-types";
import {
  historyHarness,
  oldCriteria,
  oldMatch,
  oldRecord,
  oldSpec,
  oldTrip,
  oldWatch,
} from "./service-history-fixtures";

const { cleanup, historicalBooking } = historyHarness();
afterEach(cleanup);

test("replays pre-service v2 exact authorization with the same booking ID after reopening", () => {
  // Given
  const store = historicalBooking();
  const spec = BookingSpecSchema.parse({
    ...oldSpec,
    criteria: { ...oldCriteria, service: "intercity" },
  });
  const trip = TripSchema.parse({ ...oldTrip, service: "intercity" });
  // When
  const result = store.create(spec, oldRecord.bindingHash, trip);
  // Then
  expect(result.created).toBe(false);
  expect(result.booking.id).toBe(oldRecord.id);
  expect(result.booking.spec).toEqual(spec);
  expect(store.read(oldRecord.id)?.exactTrip?.tripKey).toBe(`intercity:${oldTrip.tripKey}`);
  expect(store.read(oldRecord.id)?.receiptBaseline).toBeNull();
  expect(store.records()).toHaveLength(1);
});

test("rejects express reuse of a historical account-global idempotency key", () => {
  // Given
  const store = historicalBooking();
  const spec = BookingSpecSchema.parse({
    ...oldSpec,
    criteria: { ...oldCriteria, service: "express", departureId: "021", arrivalId: "393" },
  });
  // When / Then
  expect(() => store.create(spec, oldRecord.bindingHash)).toThrow(
    new BookingError("duplicate_key"),
  );
  expect(store.records()).toHaveLength(1);
});

test("rejects an exact trip from another service before creating a booking", () => {
  // Given
  const store = historicalBooking();
  const spec = BookingSpecSchema.parse({
    ...oldSpec,
    idempotencyKey: crypto.randomUUID(),
    criteria: { ...oldCriteria, service: "express", departureId: "021", arrivalId: "393" },
  });
  const trip = TripSchema.parse({ ...oldTrip, service: "intercity" });
  // When / Then
  expect(() => store.create(spec, oldRecord.bindingHash, trip)).toThrow(
    new BookingError("invalid_reference"),
  );
  expect(store.records()).toHaveLength(1);
});

test.each(["unknown", "express", null])(
  "rejects invalid explicit historical criteria service %j",
  (service) => {
    // Given
    const record = { ...oldRecord, spec: { ...oldSpec, criteria: { ...oldCriteria, service } } };
    // When / Then
    expect(BookingRecordSchema.safeParse(record).success).toBe(false);
  },
);

test("requires service on newly submitted booking and watch authorizations", () => {
  // Given / When / Then
  expect(BookingSpecSchema.safeParse(oldSpec).success).toBe(false);
  expect(WatchSpecSchema.safeParse(oldWatch).success).toBe(false);
  expect(WatchMatchSchema.safeParse(oldMatch).success).toBe(false);
});

test("rejects stored exact trip identity that conflicts with explicit service authorization", () => {
  // Given
  const record = {
    ...oldRecord,
    spec: {
      ...oldSpec,
      criteria: { ...oldCriteria, service: "express", departureId: "021", arrivalId: "393" },
    },
  };
  // When / Then
  expect(BookingRecordSchema.safeParse(record).success).toBe(false);
});

test("rejects partial historical v2 consent without a payment or seat decision", () => {
  // Given
  const { payment: _payment, ...noPayment } = oldSpec;
  const { seatPolicy: _seats, ...noSeats } = oldSpec;
  // When / Then
  expect(BookingRecordSchema.safeParse({ ...oldRecord, spec: noPayment }).success).toBe(false);
  expect(BookingRecordSchema.safeParse({ ...oldRecord, spec: noSeats }).success).toBe(false);
});
