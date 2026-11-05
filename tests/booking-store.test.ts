import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { BookingStore } from "../src/booking-store";
import { BookingError, BookingSpecSchema, bookingBinding } from "../src/booking-types";
import { DEFAULT_SERVICE_LIMITS } from "../src/service-limits";
import { credentials, harness, specification } from "./booking-fixtures";

const active: ReturnType<typeof harness>[] = [];
afterEach(() => {
  for (const item of active.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});
function setup() {
  const item = harness();
  active.push(item);
  return item;
}

test("deduplicates persisted authorization and rejects changed key reuse", () => {
  // Given
  const item = setup();
  const spec = specification();
  const binding = bookingBinding(credentials);
  const first = item.store.create(spec, binding);
  const secondStore = new BookingStore(item.path, "synthetic-principal", () => item.state.now);
  try {
    // When
    const repeated = secondStore.create(spec, binding);
    // Then
    expect(repeated).toEqual({ booking: first.booking, created: false });
    expect(() => secondStore.create({ ...spec, intervalSeconds: 600 }, binding)).toThrow(
      BookingError,
    );
    expect(() => secondStore.create(spec, "0".repeat(64))).toThrow(BookingError);
  } finally {
    secondStore.close();
  }
});

test("allows only one persistent compare-and-swap winner", () => {
  // Given
  const item = setup();
  const created = item.store.create(specification(), bookingBinding(credentials));
  const secondStore = new BookingStore(item.path, "synthetic-principal", () => item.state.now);
  const first = item.store.read(created.booking.id);
  const second = secondStore.read(created.booking.id);
  if (!first || !second) throw new TypeError("Missing booking");
  try {
    // When
    const winner = item.store.transition(first, "holding");
    const loser = secondStore.transition(second, "holding");
    // Then
    expect(winner?.stage).toBe("holding");
    expect(loser).toBeUndefined();
  } finally {
    secondStore.close();
  }
});

test("cancels only watching bookings and never claims in-flight cancellation", () => {
  // Given
  const item = setup();
  const created = item.store.create(specification(), bookingBinding(credentials));
  const record = item.store.read(created.booking.id);
  if (!record) throw new TypeError("Missing booking");
  item.store.transition(record, "holding");
  // When
  const result = item.store.cancel(record.id);
  // Then
  expect(result.cancelled).toBe(false);
  expect(result.booking?.stage).toBe("holding");
  expect(item.store.get(crypto.randomUUID())).toBeUndefined();
});

test("rejects authorizations without a budget, with multiple seats, or beyond the deadline", () => {
  // Given
  const spec = specification();
  const invalid = [
    { ...spec, criteria: { ...spec.criteria, maxFareKrw: undefined } },
    { ...spec, criteria: { ...spec.criteria, minSeats: 0 } },
    { ...spec, criteria: { ...spec.criteria, adjacentSeats: 2 } },
    { ...spec, preferredSeats: [1, 1] },
    { ...spec, preferredSeats: [99] },
    { ...spec, expiresAt: "2026-10-31T00:00:00+09:00" },
  ];
  // When
  const outcomes = invalid.map((value) => BookingSpecSchema.safeParse(value).success);
  // Then
  expect(outcomes).toEqual(invalid.map(() => false));
});

test("preserves idempotency and history at the bounded record capacity", () => {
  // Given
  const item = setup();
  const binding = bookingBinding(credentials);
  const firstSpec = specification();
  const first = item.store.create(firstSpec, binding);
  item.store.cancel(first.booking.id);
  for (let i = 1; i < 100; i++) {
    const record = item.store.create(specification(), binding);
    item.store.cancel(record.booking.id);
  }
  // When
  const duplicate = item.store.create(firstSpec, binding);
  // Then
  expect(duplicate.created).toBe(false);
  expect(item.store.list()).toHaveLength(100);
  expect(() => item.store.create(specification(), binding)).toThrow(BookingError);
});

test("stores private account bindings without tokens or membership identifiers", async () => {
  // Given
  const item = setup();
  // When
  await item.runner.create(specification());
  // Then
  for (const name of readdirSync(item.directory)) {
    const path = join(item.directory, name);
    expect(statSync(path).mode & 0o077).toBe(0);
    const content = readFileSync(path).toString("utf8");
    for (const secret of [
      credentials.token,
      credentials.refreshSalt,
      credentials.moappMbrsSno,
      credentials.busUserNumber,
    ])
      expect(content).not.toContain(secret);
  }
  expect(JSON.stringify(item.store.list())).not.toContain(bookingBinding(credentials));
  expect(item.state.refreshCount).toBe(0);
});

test("isolates identical idempotency keys and forbids cross-principal database reuse", () => {
  // Given
  const item = setup();
  const spec = specification();
  const first = item.store.create(spec, bookingBinding(credentials));
  const other = new BookingStore(
    join(item.directory, "other.sqlite"),
    "other-principal",
    () => item.state.now,
  );
  try {
    // When
    const second = other.create(
      spec,
      bookingBinding({ ...credentials, busUserNumber: "other-bus-user" }),
    );
    // Then
    expect(second.created).toBe(true);
    expect(second.booking.id).not.toBe(first.booking.id);
    expect(other.get(first.booking.id)).toBeUndefined();
    expect(other.cancel(first.booking.id)).toEqual({ cancelled: false, booking: undefined });
    expect(item.store.get(second.booking.id)).toBeUndefined();
    expect(() => new BookingStore(item.path, "other-principal")).toThrow(BookingError);
    expect(other.list().map(({ id }) => id)).toEqual([second.booking.id]);
  } finally {
    other.close();
  }
});

test("enforces configured booking capacity and polling boundaries", () => {
  // Given
  const store = new BookingStore(
    ":memory:",
    "limits-test",
    () => Date.parse("2026-10-30T08:00:00+09:00"),
    {
      ...DEFAULT_SERVICE_LIMITS,
      activeBookings: 1,
      retainedBookings: 2,
      minimumPollSeconds: 10,
      maximumPollSeconds: 20,
    },
  );
  const spec = { ...specification(), intervalSeconds: 10 };
  try {
    // When
    const created = store.create(spec, bookingBinding(credentials));
    // Then
    expect(created.created).toBe(true);
    expect(() =>
      store.create({ ...spec, idempotencyKey: crypto.randomUUID() }, bookingBinding(credentials)),
    ).toThrow(BookingError);
    store.cancel(created.booking.id);
    expect(() =>
      store.create(
        { ...spec, idempotencyKey: crypto.randomUUID(), intervalSeconds: 21 },
        bookingBinding(credentials),
      ),
    ).toThrow(BookingError);
  } finally {
    store.close();
  }
});

test("persists a private receipt baseline across reopening without exposing it in booking output", () => {
  // Given
  const item = setup();
  const created = item.store.create(specification(), bookingBinding(credentials));
  const record = item.store.read(created.booking.id);
  if (!record) throw new TypeError("Missing booking");
  expect(record.receiptBaseline).toBeNull();
  item.store.transition(record, "holding", { receiptBaseline: ["synthetic-prior-private-line"] });
  // When
  const reopened = new BookingStore(item.path, "synthetic-principal", () => item.state.now);
  try {
    // Then
    expect(reopened.read(record.id)?.receiptBaseline).toEqual(["synthetic-prior-private-line"]);
    expect(reopened.get(record.id)).not.toHaveProperty("receiptBaseline");
    expect(JSON.stringify(reopened.list())).not.toContain("synthetic-prior-private-line");
  } finally {
    reopened.close();
  }
});
