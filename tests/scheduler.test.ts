import { expect, test } from "bun:test";
import { runScheduler } from "../src/scheduler";

test("drains bounded user batches before waiting for the remainder of the cadence", async () => {
  // Given
  const shutdown = new AbortController();
  let now = 0;
  let ticks = 0;
  const waits: number[] = [];
  // When
  await runScheduler(
    {
      limits: { schedulerIntervalMs: 30_000, minimumPollSeconds: 5 },
      signal: shutdown.signal,
      tick: async () => {
        ticks++;
        now += 1_000;
        if (ticks === 4) shutdown.abort();
        return { remainingUsers: ticks < 3 ? 3 - ticks : 0 };
      },
    },
    {
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    },
  );
  // Then
  expect(waits).toEqual([2_000]);
  expect(ticks).toBe(4);
});

test("yields without an additional interval after a slow sweep", async () => {
  // Given
  const shutdown = new AbortController();
  let now = 0;
  const waits: number[] = [];
  // When
  await runScheduler(
    {
      limits: { schedulerIntervalMs: 30_000, minimumPollSeconds: 300 },
      signal: shutdown.signal,
      tick: async () => {
        now += 40_000;
        return { remainingUsers: 0 };
      },
    },
    {
      now: () => now,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        shutdown.abort();
      },
    },
  );
  // Then
  expect(waits).toEqual([0]);
});

test("waits the cadence for each empty sweep", async () => {
  // Given
  const shutdown = new AbortController();
  const waits: number[] = [];
  // When
  await runScheduler(
    {
      limits: { schedulerIntervalMs: 30_000, minimumPollSeconds: 300 },
      signal: shutdown.signal,
      tick: async () => ({ remainingUsers: 0 }),
    },
    {
      now: () => 0,
      wait: async (milliseconds) => {
        waits.push(milliseconds);
        if (waits.length === 3) shutdown.abort();
      },
    },
  );
  // Then
  expect(waits).toEqual([30_000, 30_000, 30_000]);
});

test("awaits the current tick and starts no remaining batch after shutdown", async () => {
  // Given
  const shutdown = new AbortController();
  const gate = Promise.withResolvers<void>();
  let ticks = 0;
  let finished = false;
  const running = runScheduler({
    limits: { schedulerIntervalMs: 30_000, minimumPollSeconds: 300 },
    signal: shutdown.signal,
    tick: async () => {
      ticks++;
      await gate.promise;
      return { remainingUsers: 10 };
    },
  }).then(() => {
    finished = true;
  });
  // When
  shutdown.abort();
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(ticks).toBe(1);
  gate.resolve();
  await running;
  // Then
  expect(finished).toBe(true);
  expect(ticks).toBe(1);
});

test("interrupts a pending timer when shutdown is requested", async () => {
  // Given
  const shutdown = new AbortController();
  let ticks = 0;
  const running = runScheduler({
    limits: { schedulerIntervalMs: 2_147_483_647, minimumPollSeconds: 2_147_483 },
    signal: shutdown.signal,
    tick: async () => {
      ticks++;
      return { remainingUsers: 0 };
    },
  });
  await Promise.resolve();
  // When
  shutdown.abort();
  await running;
  // Then
  expect(ticks).toBe(1);
});
