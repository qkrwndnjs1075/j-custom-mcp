import { describe, expect, test } from "bun:test";
import { AlertQuerySchema, WatchSpecSchema, watchDeadline } from "../src/watch-types";

const input = {
  criteria: {
    service: "intercity",
    departureId: "0000001",
    arrivalId: "0000002",
    date: "2030-01-02",
    time: "00:00",
    endTime: "23:59",
    minSeats: 1,
    passengers: { adults: 1, students: 0, children: 0 },
    ranking: ["departure_time"],
  },
  mode: "seats_available",
  intervalSeconds: 600,
  notification: "on_transition",
  retryPolicy: { mode: "exponential_backoff", maxIntervalSeconds: 86400 },
  expiresAt: "2030-01-02T21:00:00+09:00",
};
describe("watch input boundary", () => {
  test("preserves explicit criteria and cadence and normalizes expiry timezone", () => {
    const spec = WatchSpecSchema.parse(input);
    expect(spec.intervalSeconds).toBe(600);
    expect(spec.criteria).toMatchObject({ time: "00:00", endTime: "23:59", minSeats: 1 });
    expect(spec.expiresAt).toBe("2030-01-02T12:00:00.000Z");
  });

  test("bounds expiry to the inclusive departure-window minute in Korea", () => {
    const criteria = { ...input.criteria, time: "10:00", endTime: "12:30" };
    const deadline = watchDeadline(criteria);
    expect(deadline).toBe("2030-01-02T03:30:59.999Z");
    expect(WatchSpecSchema.safeParse({ ...input, criteria, expiresAt: deadline }).success).toBe(
      true,
    );
    expect(
      WatchSpecSchema.safeParse({ ...input, criteria, expiresAt: "2030-01-02T03:31:00Z" }).success,
    ).toBe(false);
  });

  test.each([
    { ...input, intervalSeconds: 0 },
    { ...input, intervalSeconds: undefined },
    { ...input, expiresAt: "2030-01-03" },
    { ...input, mode: "sold_out" },
    { ...input, criteria: { ...input.criteria, time: "12:00", endTime: "11:00" } },
    { ...input, criteria: { ...input.criteria, departureId: "x" } },
  ])("rejects malformed or unsupported criteria: %j", (value) => {
    expect(WatchSpecSchema.safeParse(value).success).toBe(false);
  });

  test.each([{ after: -1 }, { after: 1.5 }, { limit: 0 }, { after: 0, limit: 1.5 }])(
    "rejects unsafe alert pagination: %j",
    (value) => {
      expect(AlertQuerySchema.safeParse(value).success).toBe(false);
    },
  );
});

test.each(["notification", "retryPolicy"])("requires explicit %s", (field) => {
  expect(WatchSpecSchema.safeParse({ ...input, [field]: undefined }).success).toBe(false);
});
test("rejects a backoff maximum below the requested cadence", () => {
  expect(
    WatchSpecSchema.safeParse({
      ...input,
      retryPolicy: { mode: "exponential_backoff", maxIntervalSeconds: 300 },
    }).success,
  ).toBe(false);
});
