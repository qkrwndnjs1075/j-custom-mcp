import { z } from "zod";
import { bookingBinding } from "./booking-types";
import { CancellationAccount } from "./cancellation-account";
import { type CancellationClient, CancellationRunner } from "./cancellation-runner";
import type { CancellationStore } from "./cancellation-store";
import { CancellationError, type CancellationSpec, publicCancellation } from "./cancellation-types";
import { type GoCancellationSelection, type GoTicket, GoTicketSchema } from "./go-ticket-types";
import { TmoneyGoTicketClient } from "./go-tickets";
import { DEFAULT_SERVICE_LIMITS, type ServiceLimits } from "./service-limits";
import type { StateStorage } from "./transient-state";
import type { UserCredentialStore } from "./user-credentials";

const feePolicy = {
  feeEnforcement: "preflight_only",
  refundSettlement: "unverified",
} as const;
function publicTicket(ticket: GoTicket) {
  return {
    service: ticket.service,
    departureDate: ticket.departureDate,
    departureTime: ticket.departureTime,
    departureId: ticket.departureId,
    arrivalId: ticket.arrivalId,
    departureName: ticket.departureName,
    arrivalName: ticket.arrivalName,
    passengerCount: ticket.count,
    paymentMethod: "npay",
  };
}
export class CancellationService {
  readonly store: CancellationStore;
  readonly #account: CancellationAccount;
  readonly #client: CancellationClient;
  readonly #runner: CancellationRunner;
  readonly #now: () => number;
  readonly #limits: ServiceLimits;
  readonly #references = new Map<
    string,
    { readonly binding: string; readonly ticket: GoTicket; readonly expiresAt: number }
  >();
  readonly #state: StateStorage | undefined;
  readonly #pending = new Set<Promise<unknown>>();
  constructor(options: {
    readonly store: CancellationStore;
    readonly credentials: Pick<UserCredentialStore, "read" | "refresh" | "assertCurrent">;
    readonly client?: CancellationClient;
    readonly now?: () => number;
    readonly limits?: ServiceLimits;
    readonly state?: StateStorage;
  }) {
    this.store = options.store;
    this.#state = options.state;
    const saved = options.state?.get("ticket-references");
    if (saved !== undefined) {
      const entries = z
        .array(
          z.tuple([
            z.string().uuid(),
            z.strictObject({
              binding: z.string(),
              ticket: GoTicketSchema,
              expiresAt: z.number().finite(),
            }),
          ]),
        )
        .parse(saved);
      for (const [key, reference] of entries) this.#references.set(key, reference);
    }
    this.#now = options.now ?? Date.now;
    this.#limits = options.limits ?? DEFAULT_SERVICE_LIMITS;
    this.#account = new CancellationAccount(options.credentials);
    this.#client = options.client ?? new TmoneyGoTicketClient({ now: this.#now });
    this.#runner = new CancellationRunner({
      store: this.store,
      account: this.#account,
      client: this.#client,
      now: this.#now,
      pollMilliseconds: this.#limits.minimumPollSeconds * 1000,
    });
  }
  async #track<T>(operation: () => Promise<T>): Promise<T> {
    const task = operation();
    this.#pending.add(task);
    try {
      return await task;
    } finally {
      this.#pending.delete(task);
    }
  }
  async listTickets(service: GoTicket["service"]) {
    return this.#track(async () => {
      const binding = bookingBinding(await this.#account.read());
      const tickets = await this.#account.query(binding, (session) =>
        this.#client.list(session, service),
      );
      for (const [id, reference] of this.#references) {
        if (reference.expiresAt <= this.#now() || reference.binding !== binding)
          this.#references.delete(id);
      }
      if (tickets.length + this.#references.size > this.#limits.tripReferences)
        throw new CancellationError("capacity");
      const expiresAt = this.#now() + this.#limits.tripReferenceTtlSeconds * 1000;
      const result = {
        tickets: tickets.map((ticket) => {
          const ticketRef = crypto.randomUUID();
          this.#references.set(ticketRef, { binding, ticket, expiresAt });
          return { ticketRef, ...publicTicket(ticket), expiresAt };
        }),
        cancellations: this.store.list().filter((record) => record.service === service),
        ...feePolicy,
      };
      this.#state?.set("ticket-references", [...this.#references]);
      return result;
    });
  }
  async quote(ticketRef: string, selection: GoCancellationSelection["selection"]) {
    return this.#track(async () => {
      const reference = this.#references.get(ticketRef);
      if (!reference) throw new CancellationError("invalid_reference");
      if (reference.expiresAt <= this.#now()) throw new CancellationError("expired");
      const quote = await this.#account.query(reference.binding, (session) =>
        this.#client.quote(session, { ticket: reference.ticket, selection }),
      );
      const stored = this.store.saveQuote(reference.binding, quote);
      return {
        quoteRef: stored.id,
        ticket: publicTicket(quote.ticket),
        seats: quote.selectedSeats,
        feeKrw: quote.feeKrw,
        refundKrw: quote.refundKrw,
        expiresAt: stored.expiresAt,
        ...feePolicy,
      };
    });
  }
  async cancel(spec: CancellationSpec) {
    return this.#track(async () => {
      const binding = bookingBinding(await this.#account.read());
      const { record } = this.store.create(spec, binding);
      await this.#runner.run(record.id);
      const current = this.store.read(record.id);
      if (!current) throw new CancellationError("configuration");
      return { cancellation: publicCancellation(current), ...feePolicy };
    });
  }
  async tick(): Promise<void> {
    await this.#track(() => this.#runner.tick());
  }
  async disconnect(): Promise<void> {
    this.#references.clear();
    this.#state?.delete("ticket-references");
    for (const record of this.store.records()) {
      if (record.stage === "prepared")
        this.store.transition(record, "failed", { lastError: "account_changed" });
    }
    await this.whenIdle();
  }
  async whenIdle(): Promise<void> {
    await Promise.all(this.#pending);
    await this.#runner.whenIdle();
  }
}
