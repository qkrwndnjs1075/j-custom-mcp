import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmoneyIntercityClient, type TripPage } from "../src/provider";
import { runScheduler } from "../src/scheduler";
import { DEFAULT_SERVICE_LIMITS } from "../src/service-limits";
import { TenantServices } from "../src/tenant-services";
import { UserStore } from "../src/user-store";
import { UserIdSchema } from "../src/user-types";
import { WatchSpecSchema } from "../src/watch-types";
import { credentials, initialTime, specification, webTrip } from "./booking-fixtures";

class EmptyProvider extends TmoneyIntercityClient {
  calls = 0;
  gate: Promise<void> | undefined;
  override async searchTripPage(): Promise<TripPage> {
    this.calls++;
    await this.gate;
    return { trips: [], unavailable: [], continuation: null, coverage: "end", emptyStatus: "none" };
  }
}
const resources: {
  readonly dir: string;
  readonly users: UserStore;
  readonly registry: TenantServices;
}[] = [];
afterEach(async () => {
  for (const item of resources.splice(0)) {
    await item.registry.close();
    item.users.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});
function setup(limits = DEFAULT_SERVICE_LIMITS) {
  const dir = mkdtempSync(join(tmpdir(), "tenant-services-"));
  const users = new UserStore(join(dir, "users.sqlite"));
  const provider = new EmptyProvider();
  const registry = new TenantServices({
    users,
    provider,
    dataDirectory: join(dir, "tenants"),
    now: () => initialTime,
    limits,
  });
  resources.push({ dir, users, registry });
  return { dir, users, provider, registry };
}
const watchSpec = WatchSpecSchema.parse({
  mode: "seats_available",
  intervalSeconds: 600,
  notification: "on_transition",
  retryPolicy: { mode: "fixed_interval" },
  criteria: specification().criteria,
  expiresAt: specification().expiresAt,
});

test("isolates references watches and bookings between authenticated users", async () => {
  const { users, registry } = setup();
  const alice = users.connect(credentials);
  const bob = users.connect({ ...credentials, moappMbrsSno: "bob" });
  const a = registry.forUser(alice.userId);
  const b = registry.forUser(bob.userId);
  const ref = a.references.add(webTrip);
  a.watches.store.create(watchSpec);
  const request = await a.bookings.runner.create(specification());
  expect(b.references.get(ref)).toBeUndefined();
  expect(b.watches.store.list()).toEqual([]);
  expect(b.bookings.store.list()).toEqual([]);
  expect(b.bookings.store.cancel(request.booking.id).cancelled).toBe(false);
  expect(a.bookings.store.get(request.booking.id)?.stage).toBe("watching");
  expect(registry.checkout(new Request(`https://example.com/checkout/${ref}`))?.status).toBe(200);
  expect(
    registry.checkout(new Request(`https://example.com/checkout/${crypto.randomUUID()}`))?.status,
  ).toBe(410);
  expect(() => registry.forUser(UserIdSchema.parse(crypto.randomUUID()))).toThrow(
    "Connect your Tmoney GO",
  );
});

test("reloads durable user work and schedules fairly over more than ten users", async () => {
  const { users, provider, registry, dir } = setup();
  const ids = Array.from(
    { length: 12 },
    (_, index) => users.connect({ ...credentials, moappMbrsSno: `member-${index}` }).userId,
  );
  for (const id of ids) registry.forUser(id).watches.store.create(watchSpec);
  await registry.close();
  const restarted = new TenantServices({
    users,
    provider,
    dataDirectory: join(dir, "tenants"),
    now: () => initialTime,
  });
  try {
    expect(await restarted.tick()).toEqual({
      checkedUsers: 10,
      skippedOverlap: false,
      remainingUsers: 2,
    });
    expect(provider.calls).toBe(10);
    await restarted.tick();
    expect(provider.calls).toBe(12);
    for (const id of ids)
      expect(restarted.forUser(id).watches.store.list()[0]?.lastOutcome).toBe("not_matched");
  } finally {
    await restarted.close();
  }
});

test("disconnect invalidates credentials and cancels pending work without deleting financial history", async () => {
  const { users, registry, provider } = setup();
  const alice = users.connect(credentials);
  const context = registry.forUser(alice.userId);
  const watching = await context.bookings.runner.create(specification());
  const issued = await context.bookings.runner.create(specification());
  let record = context.bookings.store.read(issued.booking.id);
  if (!record) throw new TypeError("Missing fixture booking");
  for (const stage of [
    "holding",
    "held",
    "reserving",
    "reserved",
    "issuing",
    "reconciling",
    "booked",
  ] as const) {
    const next = context.bookings.store.transition(record, stage);
    if (!next) throw new TypeError("Fixture transition failed");
    record = next;
  }
  context.watches.store.create(watchSpec);
  const disconnect = registry.disconnect(alice.userId);
  expect(users.status(alice.userId)?.connected).toBe(false);
  await disconnect;
  expect(context.bookings.store.get(watching.booking.id)?.stage).toBe("cancelled");
  expect(context.bookings.store.get(issued.booking.id)?.stage).toBe("booked");
  expect(context.watches.store.list()[0]?.status).toBe("cancelled");
  expect(await context.account.getStatus("intercity")).toEqual({ connection: "not_connected" });
  await registry.tick();
  expect(provider.calls).toBe(0);
});

test("disconnect waits for an in-flight watch and suppresses its late result", async () => {
  const { users, registry, provider } = setup();
  const user = users.connect(credentials);
  const context = registry.forUser(user.userId);
  context.watches.store.create(watchSpec);
  const gate = Promise.withResolvers<void>();
  provider.gate = gate.promise;
  const ticking = registry.tick();
  expect(provider.calls).toBe(1);
  expect((await registry.tick()).skippedOverlap).toBe(true);
  let finished = false;
  const disconnect = registry.disconnect(user.userId).then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  gate.resolve();
  await Promise.all([ticking, disconnect]);
  expect(finished).toBe(true);
  expect(context.watches.store.list()[0]?.lastOutcome).toBeNull();
});

test("bounds registered users while permitting existing account reconnection", () => {
  const { users } = setup();
  for (let index = 0; index < 100; index++)
    users.connect({ ...credentials, moappMbrsSno: `member-${index}` });
  expect(() => users.connect({ ...credentials, moappMbrsSno: "member-100" })).toThrow("capacity");
  expect(users.connect({ ...credentials, moappMbrsSno: "member-0" }).connected).toBe(true);
  expect(users.list()).toHaveLength(100);
});

test("public references cross OAuth boundaries while private references remain isolated", () => {
  const { users, registry, dir } = setup();
  const shared = registry.publicContext().references;
  const publicRef = shared.add(webTrip);
  expect(existsSync(join(dir, "tenants"))).toBe(false);
  const alice = registry.forUser(users.connect(credentials).userId);
  const bob = registry.forUser(users.connect({ ...credentials, moappMbrsSno: "bob" }).userId);
  expect(alice.references.get(publicRef)).toEqual(webTrip);
  expect(bob.references.get(publicRef)).toEqual(webTrip);
  const privateRef = alice.references.add(webTrip);
  expect(shared.get(privateRef)).toBeUndefined();
  expect(bob.references.get(privateRef)).toBeUndefined();
  const quote = { ...webTrip, adultFareKrw: 20000 };
  expect(alice.references.updateQuote(publicRef, quote)).toBe(true);
  expect(shared.get(publicRef)?.adultFareKrw).toBe(20000);
  expect(bob.references.updateQuote(privateRef, quote)).toBe(false);
});

test("drains all users each cadence while honoring individual intervals and expiry", async () => {
  // Given
  const { users, provider, registry, dir } = setup();
  await registry.close();
  let now = initialTime;
  const limits = { ...DEFAULT_SERVICE_LIMITS, minimumPollSeconds: 5, schedulerUsers: 2 };
  const scheduled = new TenantServices({
    users,
    provider,
    dataDirectory: join(dir, "scheduled"),
    now: () => now,
    limits,
  });
  const ids = Array.from(
    { length: 5 },
    (_, index) => users.connect({ ...credentials, moappMbrsSno: `scheduled-${index}` }).userId,
  );
  for (const userId of ids)
    scheduled.forUser(userId).watches.store.create({
      ...watchSpec,
      intervalSeconds: 10,
      expiresAt: new Date(initialTime + 15_000).toISOString(),
    });
  const shutdown = new AbortController();
  const callsAtWait: number[] = [];
  try {
    // When
    await runScheduler(
      { tick: () => scheduled.tick(), limits, signal: shutdown.signal },
      {
        now: () => now,
        wait: async (milliseconds) => {
          callsAtWait.push(provider.calls);
          now += milliseconds;
          if (callsAtWait.length === 4) shutdown.abort();
        },
      },
    );
    // Then: every user is checked at 0s and 10s, none at 5s or expiry at 15s.
    expect(callsAtWait).toEqual([5, 5, 10, 10]);
    for (const userId of ids)
      expect(scheduled.forUser(userId).watches.store.list()[0]?.status).toBe("expired");
  } finally {
    await scheduled.close();
  }
});

test("skips disconnected queued users and includes new users in the next sweep", async () => {
  // Given
  const { users, provider, registry } = setup({ ...DEFAULT_SERVICE_LIMITS, schedulerUsers: 1 });
  const alice = users.connect(credentials);
  const bob = users.connect({ ...credentials, moappMbrsSno: "queued-bob" });
  registry.forUser(alice.userId).watches.store.create(watchSpec);
  expect((await registry.tick()).remainingUsers).toBe(1);
  await registry.disconnect(bob.userId);
  const charlie = users.connect({ ...credentials, moappMbrsSno: "new-charlie" });
  registry.forUser(charlie.userId).watches.store.create(watchSpec);
  // When
  const skipped = await registry.tick();
  const nextSweep = await registry.tick();
  const lastBatch = await registry.tick();
  // Then
  expect(skipped).toEqual({ checkedUsers: 0, skippedOverlap: false, remainingUsers: 0 });
  expect(nextSweep).toEqual({ checkedUsers: 1, skippedOverlap: false, remainingUsers: 1 });
  expect(lastBatch).toEqual({ checkedUsers: 1, skippedOverlap: false, remainingUsers: 0 });
  expect(provider.calls).toBe(2);
});
