import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CancellationStore } from "../src/cancellation-store";
import { CancellationError, publicCancellation } from "../src/cancellation-types";
import { binding, cancellationHarness } from "./cancellation-store-fixtures";
import { account, fixture, ticket } from "./go-ticket-fixtures";

const active: Awaited<ReturnType<typeof cancellationHarness>>[] = [];
afterEach(() => {
  for (const item of active.splice(0)) item.dispose();
});
async function setup() {
  const item = await cancellationHarness();
  active.push(item);
  return item;
}

test("bounded retained cancellations preserve terminal history and replay", async () => {
  // Given
  const item = await setup();
  const first = item.store.create(item.spec, binding).record;
  item.store.transition(first, "failed", { lastError: "expired" });
  for (let index = 0; index < 2; index++) {
    const record = item.store.create(
      { ...item.spec, idempotencyKey: crypto.randomUUID() },
      binding,
    ).record;
    item.store.transition(record, "failed", { lastError: "expired" });
  }
  // When / Then
  expect(() =>
    item.store.create({ ...item.spec, idempotencyKey: crypto.randomUUID() }, binding),
  ).toThrow(new CancellationError("capacity"));
  expect(item.store.list()).toHaveLength(3);
  expect(item.store.create(item.spec, binding).created).toBe(false);
});
test("active capacity counts prepared and uncertain requests", async () => {
  // Given
  const item = await setup();
  const first = item.store.create(item.spec, binding).record;
  const claimed = item.store.claim(first.id, 0, item.quote);
  if (!claimed) throw new TypeError("Missing claim");
  item.store.transition(claimed, "uncertain");
  item.store.create({ ...item.spec, idempotencyKey: crypto.randomUUID() }, binding);
  // When / Then
  expect(() =>
    item.store.create({ ...item.spec, idempotencyKey: crypto.randomUUID() }, binding),
  ).toThrow(new CancellationError("capacity"));
  expect(item.store.list()).toHaveLength(2);
});
test("quote capacity rejects overflow and expiry pruning retains financial replay", async () => {
  // Given
  const item = await setup();
  item.store.create(item.spec, binding);
  item.store.saveQuote(binding, item.quote);
  item.store.saveQuote(binding, item.quote);
  expect(() => item.store.saveQuote(binding, item.quote)).toThrow(
    new CancellationError("capacity"),
  );
  item.state.now = item.saved.expiresAt;
  // When
  const fresh = item.store.saveQuote(binding, { ...item.quote, quotedAt: item.state.now });
  // Then
  expect(fresh.expiresAt).toBeGreaterThan(item.state.now);
  expect(item.store.getQuote(item.saved.id)).toBeNull();
  expect(item.store.create(item.spec, binding).created).toBe(false);
});
test("public outcome reports confirmed actual money without private native authority", async () => {
  // Given
  const item = await setup();
  const record = item.store.create(item.spec, binding).record;
  const claimed = item.store.claim(record.id, 0, item.quote);
  if (!claimed) throw new TypeError("Missing claim");
  const completed = item.store.transition(claimed, "cancelled", {
    outcome: {
      status: "confirmed",
      feeKrw: 1200,
      refundKrw: 18800,
      cancelledAt: "20261024120000",
    },
  });
  if (!completed) throw new TypeError("Missing completion");
  // When
  const visible = publicCancellation(completed);
  // Then
  expect(visible.actualFeeKrw).toBe(1200);
  expect(visible.actualRefundKrw).toBe(18800);
  expect(visible.quotedFeeKrw).toBe(1000);
  expect(visible.feeChanged).toBe(true);
  for (const key of [
    "ownerUserNumber",
    "lineNumber",
    "orderNumber",
    "issuanceId",
    "ticketSequence",
    "historyBaseline",
    "payload",
    "bindingHash",
    "targetKey",
  ])
    expect(JSON.stringify(visible)).not.toContain(key);
  for (const name of readdirSync(item.directory))
    expect(statSync(join(item.directory, name)).mode & 0o077).toBe(0);
});
test("foreign database owners and quote bindings cannot obtain cancellation authority", async () => {
  // Given
  const item = await setup();
  // When / Then
  expect(() => new CancellationStore(item.path, "foreign-principal", item.options)).toThrow(
    CancellationError,
  );
  expect(() => item.store.create(item.spec, "a".repeat(64))).toThrow(
    new CancellationError("account_changed"),
  );
  expect(item.store.records()).toHaveLength(0);
});
test("opening cancellation storage leaves unrelated booking records unchanged", async () => {
  // Given
  const item = await setup();
  const db = new Database(item.path);
  const preserved = JSON.stringify({ synthetic: "opaque preexisting booking" });
  db.query("INSERT INTO bookings VALUES (?,?,?,?,?,?)").run(
    "existing",
    "existing-key",
    "uncertain",
    2,
    item.state.now,
    preserved,
  );
  try {
    // When
    item.reopen();
    // Then
    expect(
      db.query<{ record: string }, []>("SELECT record FROM bookings WHERE id='existing'").get()
        ?.record,
    ).toBe(preserved);
  } finally {
    db.close();
  }
});
test("malformed persisted cancellation authority rejects recovery before any action", async () => {
  // Given
  const item = await setup();
  const record = item.store.create(item.spec, binding).record;
  const db = new Database(item.path);
  db.query("UPDATE cancellations SET record=? WHERE id=?").run(
    JSON.stringify({ ...record, quote: { ...record.quote, selectedSeats: [98] } }),
    record.id,
  );
  try {
    // When / Then
    expect(() => item.reopen()).toThrow(new CancellationError("configuration"));
  } finally {
    db.close();
  }
});
test("different seat selections on one line share the unresolved target lock", async () => {
  // Given
  const item = await setup();
  const client = fixture("express").client;
  const firstQuote = await client.quote(account, {
    ticket: ticket("express"),
    selection: { mode: "seats", seats: [1] },
  });
  const secondQuote = await client.quote(account, {
    ticket: ticket("express"),
    selection: { mode: "seats", seats: [2] },
  });
  const firstRef = item.store.saveQuote(binding, firstQuote);
  const secondRef = item.store.saveQuote(binding, secondQuote);
  const first = item.store.create({ ...item.spec, quoteRef: firstRef.id }, binding).record;
  const second = item.store.create(
    { ...item.spec, idempotencyKey: crypto.randomUUID(), quoteRef: secondRef.id },
    binding,
  ).record;
  item.store.claim(first.id, 0, firstQuote);
  // When / Then
  expect(() => item.store.claim(second.id, 0, secondQuote)).toThrow(
    new CancellationError("target_busy"),
  );
});
test("uncertain attempts cannot become prepared, submitting, or failed", async () => {
  // Given
  const item = await setup();
  const record = item.store.create(item.spec, binding).record;
  const claimed = item.store.claim(record.id, 0, item.quote);
  if (!claimed) throw new TypeError("Missing claim");
  const uncertain = item.store.transition(claimed, "uncertain");
  if (!uncertain) throw new TypeError("Missing uncertain record");
  // When / Then
  for (const stage of ["prepared", "submitting", "failed"] as const)
    expect(() => item.store.transition(uncertain, stage)).toThrow(
      new CancellationError("configuration"),
    );
});

test("identical native line numbers in different services do not share an attempt lock", async () => {
  // Given
  const item = await setup();
  const secondQuote = await fixture("intercity").client.quote(account, {
    ticket: ticket("intercity"),
    selection: { mode: "all" },
  });
  const secondRef = item.store.saveQuote(binding, secondQuote);
  const first = item.store.create(item.spec, binding).record;
  const second = item.store.create(
    { ...item.spec, quoteRef: secondRef.id, idempotencyKey: crypto.randomUUID() },
    binding,
  ).record;
  item.store.claim(first.id, 0, item.quote);
  // When
  const claimed = item.store.claim(second.id, 0, secondQuote);
  // Then
  expect(claimed?.stage).toBe("submitting");
});
