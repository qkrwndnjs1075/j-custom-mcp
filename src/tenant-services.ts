import { join } from "node:path";
import { z } from "zod";
import { BookingRunner } from "./booking-runner";
import { BookingStore } from "./booking-store";
import type { BookingServices } from "./booking-tools";
import type { BusProvider } from "./bus-provider";
import { CancellationService } from "./cancellation-service";
import { CancellationStore } from "./cancellation-store";
import { createCheckoutHandler } from "./checkout";
import type { TmoneyGoAccountClient } from "./go-account";
import { TripQueryService } from "./query";
import { DEFAULT_SERVICE_LIMITS, type ServiceLimits } from "./service-limits";
import type { SyncDatabase } from "./sql-database";
import { TenantAccountService } from "./tenant-account";
import type { StateStorage } from "./transient-state";
import { type TripReferenceStore, TripReferences, withPublicReferences } from "./trip-references";
import { UserCredentialStore } from "./user-credentials";
import type { UserStore } from "./user-store";
import { type UserId, UserIdSchema, UserStoreError } from "./user-types";
import { privateVaultFile } from "./user-vault";
import { evaluateWatch } from "./watch-evaluator";
import { WatchRunner } from "./watch-runner";
import { WatchStore } from "./watch-store";
import type { WatchServices } from "./watch-tools";

export type TenantContext = {
  readonly provider: BusProvider;
  readonly query: TripQueryService;
  readonly references: TripReferenceStore;
  readonly account: TenantAccountService;
  readonly watches: WatchServices;
  readonly bookings: BookingServices;
  readonly cancellations: CancellationService;
};
export type TenantPersistence = {
  readonly database: (userId: UserId, kind: "booking" | "watch") => SyncDatabase;
  readonly state: (scope: string) => StateStorage;
};
export class TenantServiceError extends Error {
  override readonly name = "TenantServiceError";
  constructor(readonly code: "capacity" | "closed") {
    super(code === "capacity" ? "User service capacity reached." : "User services are closed.");
  }
}

export class TenantServices {
  readonly #contexts = new Map<UserId, TenantContext>();
  readonly #query: TripQueryService;
  readonly #publicReferences: TripReferences;
  readonly #now: () => number;
  readonly #limits: ServiceLimits;
  readonly #scheduledUsers: UserId[] = [];
  #pending: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly options: {
      readonly users: UserStore;
      readonly dataDirectory: string;
      readonly provider: BusProvider;
      readonly query?: TripQueryService;
      readonly accountClient?: TmoneyGoAccountClient;
      readonly now?: () => number;
      readonly limits?: ServiceLimits;
      readonly persistence?: TenantPersistence;
    },
  ) {
    this.#now = options.now ?? Date.now;
    this.#limits = options.limits ?? DEFAULT_SERVICE_LIMITS;
    this.#publicReferences = new TripReferences(
      this.#now,
      this.#limits,
      options.persistence?.state("public"),
    );
    this.#query = options.query ?? new TripQueryService(options.provider, this.#now, this.#limits);
    if (options.users.list().length > this.#limits.accounts)
      throw new TenantServiceError("capacity");
    const scheduled = options.persistence?.state("scheduler").get("queue");
    if (scheduled !== undefined)
      this.#scheduledUsers.push(
        ...z.array(UserIdSchema).max(this.#limits.accounts).parse(scheduled),
      );
  }

  publicContext() {
    if (this.#closed) throw new TenantServiceError("closed");
    return {
      provider: this.options.provider,
      query: this.#query,
      references: this.#publicReferences,
    };
  }

  forUser(userId: UserId): TenantContext {
    if (this.#closed) throw new TenantServiceError("closed");
    const parsed = UserIdSchema.safeParse(userId);
    if (!parsed.success || !this.options.users.status(parsed.data))
      throw new UserStoreError("disconnected");
    const existing = this.#contexts.get(parsed.data);
    if (existing) return existing;
    if (this.#contexts.size >= this.#limits.accounts) throw new TenantServiceError("capacity");
    const directory = join(this.options.dataDirectory, parsed.data);
    const credentials = new UserCredentialStore(this.options.users, parsed.data);
    const watchStore = new WatchStore(
      this.options.persistence?.database(parsed.data, "watch") ??
        privateVaultFile(join(directory, "watches.sqlite")),
      this.#now,
      this.#limits,
    );
    let bookingStore: BookingStore | undefined;
    let cancellationStore: CancellationStore | undefined;
    try {
      bookingStore = new BookingStore(
        this.options.persistence?.database(parsed.data, "booking") ??
          join(directory, "bookings.sqlite"),
        parsed.data,
        this.#now,
        this.#limits,
      );
      cancellationStore = new CancellationStore(
        this.options.persistence?.database(parsed.data, "booking") ??
          join(directory, "bookings.sqlite"),
        parsed.data,
        {
          now: this.#now,
          limits: this.#limits,
        },
      );
      const context: TenantContext = {
        cancellations: new CancellationService({
          store: cancellationStore,
          credentials,
          now: this.#now,
          limits: this.#limits,
          ...(this.options.persistence
            ? { state: this.options.persistence.state(`tickets:${parsed.data}`) }
            : {}),
        }),
        provider: this.options.provider,
        query: this.#query,
        references: withPublicReferences(
          new TripReferences(
            this.#now,
            this.#limits,
            this.options.persistence?.state(`trips:${parsed.data}`),
          ),
          this.#publicReferences,
        ),
        account: new TenantAccountService(credentials, this.options.accountClient),
        watches: {
          store: watchStore,
          runner: new WatchRunner({
            store: watchStore,
            evaluate: (criteria, mode) => evaluateWatch(this.#query, criteria, mode),
          }),
        },
        bookings: {
          store: bookingStore,
          runner: new BookingRunner({
            store: bookingStore,
            credentials,
            query: this.#query,
            now: this.#now,
            limits: this.#limits,
          }),
        },
      };
      this.#contexts.set(parsed.data, context);
      return context;
    } catch (error) {
      watchStore.close();
      bookingStore?.close();
      cancellationStore?.close();
      throw error;
    }
  }

  async disconnect(userId: UserId) {
    const connection = this.options.users.disconnect(userId);
    const context = this.forUser(userId);
    for (const booking of context.bookings.store.list()) context.bookings.store.cancel(booking.id);
    for (const watch of context.watches.store.list()) context.watches.store.cancel(watch.id);
    await context.cancellations.disconnect();
    await Promise.all([
      context.bookings.runner.whenIdle(),
      context.watches.runner.whenIdle(),
      context.cancellations.whenIdle(),
    ]);
    return connection;
  }

  checkout(request: Request): Response | undefined {
    const reference = /^\/checkout\/([^/]+)\/?$/.exec(new URL(request.url).pathname)?.[1];
    if (reference && this.options.persistence)
      for (const user of this.options.users.list()) if (user.connected) this.forUser(user.userId);
    for (const context of this.#contexts.values()) {
      if (reference && context.references.get(reference))
        return createCheckoutHandler({ references: context.references })(request);
    }
    return createCheckoutHandler({ references: this.#publicReferences })(request);
  }

  async tick(): Promise<{
    readonly checkedUsers: number;
    readonly skippedOverlap: boolean;
    readonly remainingUsers: number;
  }> {
    if (this.#closed) throw new TenantServiceError("closed");
    if (this.#pending) return { checkedUsers: 0, skippedOverlap: true, remainingUsers: 0 };
    const completion = Promise.withResolvers<void>();
    this.#pending = completion.promise;
    let checkedUsers = 0;
    try {
      if (this.#scheduledUsers.length === 0) {
        const users = this.options.users.list();
        if (users.length > this.#limits.accounts) throw new TenantServiceError("capacity");
        this.#scheduledUsers.push(
          ...users.filter((user) => user.connected).map((user) => user.userId),
        );
      }
      const batch = this.#scheduledUsers.splice(0, this.#limits.schedulerUsers);
      this.options.persistence?.state("scheduler").set("queue", this.#scheduledUsers);
      for (const userId of batch) {
        if (this.#closed) break;
        if (!this.options.users.status(userId)?.connected) continue;
        const context = this.forUser(userId);
        await context.watches.runner.tick();
        if (this.options.users.status(userId)?.connected) await context.bookings.runner.tick();
        if (this.options.users.status(userId)?.connected) await context.cancellations.tick();
        checkedUsers++;
      }
      return { checkedUsers, skippedOverlap: false, remainingUsers: this.#scheduledUsers.length };
    } finally {
      this.#pending = undefined;
      completion.resolve();
    }
  }

  nextWakeAt(): number | undefined {
    if (this.#scheduledUsers.length > 0) return this.#now();
    let next: number | undefined;
    const include = (time: number) => {
      if (Number.isFinite(time)) next = next === undefined ? time : Math.min(next, time);
    };
    for (const user of this.options.users.list()) {
      if (!user.connected) continue;
      const context = this.forUser(user.userId);
      for (const watch of context.watches.store.list())
        if (watch.status === "active")
          include(Math.min(Date.parse(watch.nextCheckAt), Date.parse(watch.expiresAt)));
      for (const booking of context.bookings.store.records()) {
        if (booking.stage === "watching")
          include(Math.min(booking.nextCheckAt, Date.parse(booking.spec.expiresAt)));
        else if (
          booking.stage === "reconciling" ||
          (booking.stage === "uncertain" &&
            booking.issueAttempted &&
            booking.hold !== null &&
            booking.purchaseMonth !== null)
        )
          include(booking.nextCheckAt);
      }
      for (const cancellation of context.cancellations.store.records())
        if (cancellation.stage === "submitting" || cancellation.stage === "uncertain")
          include(cancellation.nextCheckAt);
    }
    return next;
  }

  async whenIdle(): Promise<void> {
    await this.#pending;
    await Promise.all(
      [...this.#contexts.values()].flatMap((context) => [
        context.watches.runner.whenIdle(),
        context.bookings.runner.whenIdle(),
        context.cancellations.whenIdle(),
      ]),
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.whenIdle();
    for (const context of this.#contexts.values()) {
      context.watches.store.close();
      context.bookings.store.close();
      context.cancellations.store.close();
    }
    this.#contexts.clear();
  }
}
