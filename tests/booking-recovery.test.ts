import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BookingRunner } from "../src/booking-runner";
import { BookingError, type BookingStage } from "../src/booking-types";
import { harness, held, specification } from "./booking-fixtures";

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

test.each(["holding", "held", "reserving", "reserved", "issuing"] as const)(
  "does not resume mutations after a crash in %s",
  async (interrupted) => {
    // Given
    const item = setup();
    item.state.outcome = { status: "unknown" };
    const created = await item.runner.create(specification());
    let record = item.store.read(created.booking.id);
    if (!record) throw new TypeError("Missing booking");
    const stages: readonly BookingStage[] = ["holding", "held", "reserving", "reserved", "issuing"];
    for (const stage of stages) {
      const next = item.store.transition(record, stage, {
        ...(stage === "held" ? { hold: held } : {}),
        ...(stage === "reserving" ? { purchaseMonth: "202610" } : {}),
        ...(stage === "reserved" ? { paymentOrderNumber: "synthetic-payment-order-private" } : {}),
        ...(stage === "issuing" ? { issueAttempted: true } : {}),
      });
      if (!next) throw new TypeError("Failed setup transition");
      record = next;
      if (stage === interrupted) break;
    }
    // When
    await new BookingRunner(item.options).tick();
    // Then
    expect(item.store.get(created.booking.id)?.stage).toBe("uncertain");
    expect(
      item.actions.some(({ action }) => ["hold", "reserve", "issue", "release"].includes(action)),
    ).toBe(false);
    expect(item.actions.filter(({ action }) => action === "reconcile")).toHaveLength(
      interrupted === "issuing" ? 1 : 0,
    );
  },
);

test("does not execute a cancelled authorization", async () => {
  // Given
  const item = setup();
  const created = await item.runner.create(specification());
  item.store.cancel(created.booking.id);
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)?.stage).toBe("cancelled");
  expect(item.actions).toEqual([]);
});

test("expires watching authorization without querying or mutating", async () => {
  // Given
  const item = setup();
  const spec = specification();
  const created = await item.runner.create(spec);
  item.state.now = Date.parse(spec.expiresAt);
  // When
  await item.runner.tick();
  // Then
  expect(item.store.get(created.booking.id)?.stage).toBe("expired");
  expect(item.actions).toEqual([]);
});

test("keeps the active authorization capacity at twenty", async () => {
  // Given
  const item = setup();
  for (let i = 0; i < 20; i++) await item.runner.create(specification());
  // When
  const operation = item.runner.create(specification());
  // Then
  await expect(operation).rejects.toBeInstanceOf(BookingError);
  expect(item.store.list()).toHaveLength(20);
});
