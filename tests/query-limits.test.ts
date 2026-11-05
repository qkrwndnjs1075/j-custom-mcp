import { expect, test } from "bun:test";
import { TripQueryService } from "../src/query";
import { criteria, noSeats, page, seats, trip } from "./query-fixtures";

test("page, seat and elapsed budgets stop further work and retain positives", async () => {
  let pages = 0;
  const paging = new TripQueryService({
    searchTripPage: async () => page([trip(String(++pages))], String(pages)),
    getSeats: noSeats,
  });
  expect((await paging.scan(criteria)).reasons).toContain("page_limit");
  expect(pages).toBe(10);
  let checks = 0;
  const seating = new TripQueryService({
    searchTripPage: async () => page(Array.from({ length: 11 }, (_, i) => trip(String(i)))),
    getSeats: async () => {
      checks++;
      return seats;
    },
  });
  const result = await seating.scan({ ...criteria, adjacentSeats: 2 });
  expect(result.reasons).toContain("seat_check_limit");
  expect(result.matches).toHaveLength(10);
  expect(checks).toBe(10);
  let clock = 0;
  let timedCalls = 0;
  const timed = new TripQueryService(
    {
      searchTripPage: async () => {
        timedCalls++;
        clock = 30000;
        return page([trip("a")], "next");
      },
      getSeats: noSeats,
    },
    () => clock,
  );
  expect((await timed.scan(criteria)).reasons).toContain("time_limit");
  expect(timedCalls).toBe(1);
});

test("configured query budgets replace fixed page and seat limits", async () => {
  // Given: a service configured to inspect one page and one seat map.
  const { DEFAULT_SERVICE_LIMITS } = await import("../src/service-limits");
  let pages = 0;
  let seatChecks = 0;
  const service = new TripQueryService(
    {
      searchTripPage: async () => {
        pages++;
        return page([trip("a"), trip("b")], "next");
      },
      getSeats: async () => {
        seatChecks++;
        return seats;
      },
    },
    () => 0,
    { ...DEFAULT_SERVICE_LIMITS, queryPages: 1, querySeatChecks: 1 },
  );
  // When: the request needs more than the configured budget.
  const result = await service.scan({ ...criteria, adjacentSeats: 2 });
  // Then: the exact configured limits stop requests and disclose partial coverage.
  expect([pages, seatChecks]).toEqual([1, 1]);
  expect([...result.reasons].sort()).toEqual(["page_limit", "seat_check_limit"]);
});
