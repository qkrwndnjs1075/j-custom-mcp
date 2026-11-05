import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigSchema } from "../src/app-config";
import { ServiceLimitsSchema } from "../src/service-limits";
import { TripReferences } from "../src/trip-references";
import { UserStore } from "../src/user-store";
import { credentials, webTrip } from "./booking-fixtures";

test("configured account capacity rejects new accounts but permits reconnecting an existing member", () => {
  // Given
  const directory = mkdtempSync(join(tmpdir(), "account-limit-"));
  const store = new UserStore(join(directory, "users.sqlite"), { accountLimit: 1 });
  const first = store.connect(credentials);
  try {
    // When / Then
    expect(() =>
      store.connect({ ...credentials, moappMbrsSno: "another-synthetic-member" }),
    ).toThrow();
    expect(store.connect({ ...credentials, token: "synthetic-renewed" }).userId).toBe(first.userId);
    expect(store.list()).toHaveLength(1);
    expect(JSON.stringify(store)).toBe("{}");
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("configured reference capacity and lifetime change eviction without extending a refreshed quote", () => {
  // Given
  let now = 0;
  const limits = ServiceLimitsSchema.parse({ tripReferences: 1, tripReferenceTtlSeconds: 2 });
  const references = new TripReferences(() => now, limits);
  const oldest = references.add(webTrip);
  const current = references.add(webTrip);
  // When
  now = 1_999;
  const refreshed = references.updateQuote(current, {
    adultFareKrw: 17_000,
    totalFareKrw: 17_000,
    remainingSeats: 2,
    fareQuotes: {
      adults: { unitFareKrw: 17_000, fareKindCode: "IG00" },
      students: null,
      children: null,
    },
  });
  now = 2_000;
  // Then
  expect(refreshed).toBe(true);
  expect(references.get(oldest)).toBeUndefined();
  expect(references.get(current)).toBeUndefined();
  expect(references.updateQuote(current, webTrip)).toBe(false);
});

test.each([
  "not json",
  '{"accounts":0}',
  '{"activeBookings":3,"retainedBookings":2}',
  '{"minimumPollSeconds":20,"maximumPollSeconds":10}',
  '{"unknownLimit":5}',
  '{"schedulerIntervalMs":2147483648}',
])("rejects unusable operator limits before application startup: %s", (MCP_LIMITS) => {
  // Given / When / Then
  expect(AppConfigSchema.safeParse({ MCP_LIMITS }).success).toBe(false);
});
