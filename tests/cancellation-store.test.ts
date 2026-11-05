import { afterEach, expect, test } from "bun:test";
import { CancellationError } from "../src/cancellation-types";
import { binding, cancellationHarness } from "./cancellation-store-fixtures";

const active: Awaited<ReturnType<typeof cancellationHarness>>[] = [];
afterEach(() => {
  for (const item of active.splice(0)) item.dispose();
});
async function setup(service: "intercity" | "express" = "express") {
  const item = await cancellationHarness(service);
  active.push(item);
  return item;
}
for (const service of ["intercity", "express"] as const) {
  test(`${service} cancellation has one durable claim winner across connections`, async () => {
    // Given
    const item = await setup(service);
    const other = item.reopen();
    const { record } = item.store.create(item.spec, binding);
    // When
    const winner = item.store.claim(record.id, record.revision, item.quote);
    const loser = other.claim(record.id, record.revision, item.quote);
    // Then
    expect(winner?.stage).toBe("submitting");
    expect(loser).toBeUndefined();
    expect(other.read(record.id)?.revision).toBe(1);
  });
}
test("different request keys cannot claim the same service and line while an attempt is uncertain", async () => {
  // Given
  const item = await setup();
  const other = item.reopen();
  const first = item.store.create(item.spec, binding).record;
  const second = other.create(
    { ...item.spec, idempotencyKey: crypto.randomUUID() },
    binding,
  ).record;
  const claim = item.store.claim(first.id, first.revision, item.quote);
  if (!claim) throw new TypeError("Missing claim");
  item.store.transition(claim, "uncertain");
  // When / Then
  expect(() => other.claim(second.id, second.revision, item.quote)).toThrow(
    new CancellationError("target_busy"),
  );
  expect(other.read(second.id)?.stage).toBe("prepared");
});
test("reopening recovers submitting to reconciliation without resubmission", async () => {
  // Given
  const item = await setup();
  const first = item.store.create(item.spec, binding).record;
  item.store.claim(first.id, first.revision, item.quote);
  const prepared = item.store.create(
    { ...item.spec, idempotencyKey: crypto.randomUUID() },
    binding,
  ).record;
  // When
  const recovered = item.reopen();
  // Then
  const pending = recovered.read(first.id);
  expect(pending?.stage).toBe("uncertain");
  expect(recovered.due().map((record) => record.id)).toEqual([first.id]);
  expect(recovered.read(prepared.id)?.stage).toBe("prepared");
  expect(recovered.claim(first.id, pending?.revision ?? 0, item.quote)).toBeUndefined();
});
test("stale completion cannot overwrite a newer reconciliation revision", async () => {
  // Given
  const item = await setup();
  const first = item.store.create(item.spec, binding).record;
  const claimed = item.store.claim(first.id, first.revision, item.quote);
  if (!claimed) throw new TypeError("Missing claim");
  item.store.transition(claimed, "uncertain");
  // When
  const result = item.store.transition(claimed, "cancelled", {
    outcome: { status: "confirmed", feeKrw: 1000, refundKrw: 19000, cancelledAt: "20261024120000" },
  });
  // Then
  expect(result).toBeUndefined();
  expect(item.store.read(first.id)?.stage).toBe("uncertain");
});
test("expired quote replay preserves prior authorization while new keys are rejected", async () => {
  // Given
  const item = await setup();
  const first = item.store.create(item.spec, binding);
  item.state.now = item.saved.expiresAt;
  // When
  const replay = item.store.create(item.spec, binding);
  // Then
  expect(replay).toEqual({ record: first.record, created: false });
  expect(() =>
    item.store.create({ ...item.spec, idempotencyKey: crypto.randomUUID() }, binding),
  ).toThrow(new CancellationError("expired"));
  expect(() =>
    item.store.claim(first.record.id, 0, { ...item.quote, quotedAt: item.state.now }),
  ).toThrow(new CancellationError("expired"));
});
test("existing idempotency keys reject account or full specification changes", async () => {
  // Given
  const item = await setup();
  item.store.create(item.spec, binding);
  // When / Then
  expect(() => item.store.create(item.spec, "a".repeat(64))).toThrow(
    new CancellationError("duplicate_key"),
  );
  expect(() => item.store.create({ ...item.spec, acceptedFeeKrw: 0 }, binding)).toThrow(
    new CancellationError("duplicate_key"),
  );
  expect(() => item.store.create({ ...item.spec, quoteRef: crypto.randomUUID() }, binding)).toThrow(
    new CancellationError("duplicate_key"),
  );
});
test("fees and fresh target authority must match before any durable attempt", async () => {
  // Given
  const item = await setup();
  const first = item.store.create(item.spec, binding).record;
  // When / Then
  expect(() => item.store.claim(first.id, 0, { ...item.quote, feeKrw: 2000 })).toThrow(
    new CancellationError("fee_changed"),
  );
  expect(() =>
    item.store.claim(first.id, 0, {
      ...item.quote,
      ticket: { ...item.quote.ticket, ownerUserNumber: "foreign" },
    }),
  ).toThrow(CancellationError);
  expect(() =>
    item.store.claim(first.id, 0, { ...item.quote, quotedAt: item.state.now + 1 }),
  ).toThrow(new CancellationError("expired"));
  expect(item.store.read(first.id)?.stage).toBe("prepared");
});
