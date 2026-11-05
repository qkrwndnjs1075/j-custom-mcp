import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BookingRunner } from "../src/booking-runner";
import { harness } from "./booking-fixtures";
import { historicalHold } from "./booking-legacy-fixtures";

const historical = {
  id: "b6f83e90-1972-4b8d-bbf0-e76af4fc1950",
  spec: {
    idempotencyKey: "7afac127-e909-48dd-89d1-e0a3cfe30646",
    criteria: {
      departureId: "0000001",
      arrivalId: "0000002",
      date: "2026-10-30",
      time: "00:00",
      endTime: "23:59",
      maxFareKrw: 20000,
      minSeats: 1,
    },
    expiresAt: "2026-10-30T00:00:00.000Z",
    intervalSeconds: 600,
    preferredSeats: [1],
  },
  stage: "watching",
  bindingHash: "a".repeat(64),
  revision: 4,
  createdAt: 1793300000000,
  updatedAt: 1793300000000,
  nextCheckAt: 0,
  checkCount: 2,
  lastError: null,
  hold: null,
  selection: null,
  purchaseMonth: null,
  paymentOrderNumber: null,
  issueAttempted: false,
  releaseAccepted: null,
};

test("cancels a literal v1 queued authorization without inventing v2 consent", async () => {
  // Given
  const item = harness();
  const db = new Database(item.path);
  db.query("INSERT INTO bookings VALUES (?,?,?,?,?,?)").run(
    historical.id,
    historical.spec.idempotencyKey,
    historical.stage,
    historical.revision,
    0,
    JSON.stringify(historical),
  );
  db.close();
  try {
    // When
    await new BookingRunner(item.options).tick();
    // Then
    expect(item.store.get(historical.id)).toMatchObject({
      stage: "cancelled",
      lastError: "reauthorization_required",
      spec: historical.spec,
    });
    expect(item.actions).toEqual([]);
    expect(item.store.read(historical.id)?.bindingHash).toBe(historical.bindingHash);
  } finally {
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});

test("retains a literal v1 in-flight payment order without new mutations", async () => {
  // Given
  const item = harness();
  const db = new Database(item.path);
  const interrupted = {
    ...historical,
    hold: historicalHold,
    stage: "reserved",
    paymentOrderNumber: "historical-order-private",
    purchaseMonth: "202610",
  };
  db.query("INSERT INTO bookings VALUES (?,?,?,?,?,?)").run(
    interrupted.id,
    interrupted.spec.idempotencyKey,
    interrupted.stage,
    interrupted.revision,
    0,
    JSON.stringify(interrupted),
  );
  db.close();
  try {
    // When
    await new BookingRunner(item.options).tick();
    // Then
    expect(item.store.read(interrupted.id)).toMatchObject({
      stage: "uncertain",
      hold: { holdId: "historical-hold-private", seat: "01" },
      paymentOrderNumber: "historical-order-private",
      purchaseMonth: "202610",
      bindingHash: historical.bindingHash,
    });
    expect(item.actions).toEqual([]);
  } finally {
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});
