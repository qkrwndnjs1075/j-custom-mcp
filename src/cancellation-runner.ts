import type { CancellationAccount } from "./cancellation-account";
import type { CancellationStore } from "./cancellation-store";
import {
  CancellationError,
  type CancellationErrorCode,
  type CancellationRecord,
} from "./cancellation-types";
import { GoBusError } from "./go-bus-types";
import type { TmoneyGoTicketClient } from "./go-tickets";
import { UserStoreError } from "./user-types";

export type CancellationClient = Pick<
  TmoneyGoTicketClient,
  "list" | "quote" | "cancel" | "reconcile"
>;
function failure(error: unknown): CancellationErrorCode {
  if (error instanceof CancellationError) return error.code;
  if (error instanceof UserStoreError)
    return error.code === "connection_changed" ? "account_changed" : "authentication";
  if (error instanceof GoBusError)
    return error.code === "authentication_required" ? "authentication" : "response";
  throw error;
}
export class CancellationRunner {
  readonly #pending = new Map<string, Promise<void>>();
  constructor(
    private readonly options: {
      readonly store: CancellationStore;
      readonly account: CancellationAccount;
      readonly client: CancellationClient;
      readonly now: () => number;
      readonly pollMilliseconds: number;
    },
  ) {}
  async run(id: string): Promise<void> {
    const running = this.#pending.get(id);
    if (running) return running;
    const task = this.#run(id);
    this.#pending.set(id, task);
    try {
      await task;
    } finally {
      this.#pending.delete(id);
    }
  }
  async #run(id: string): Promise<void> {
    const { store, account, client } = this.options;
    let record = store.read(id);
    if (!record) throw new CancellationError("invalid_reference");
    switch (record.stage) {
      case "cancelled":
      case "failed":
        return;
      case "submitting":
      case "uncertain":
        await this.#reconcile(record);
        return;
      case "prepared":
        break;
    }
    try {
      const original = record;
      const fresh = await account.query(record.bindingHash, (session) =>
        client.quote(session, {
          ticket: original.quote.ticket,
          selection: { mode: "seats", seats: original.quote.selectedSeats },
        }),
      );
      const credentials = await account.read(record.bindingHash);
      const session = account.context(credentials);
      const claimed = store.claim(record.id, record.revision, fresh);
      if (!claimed) return;
      record = claimed;
      await client.cancel(session, claimed.quote);
    } catch (error) {
      // The durable claim precedes the wire call: every later failure requires history proof.
      if (record.stage === "prepared") {
        store.transition(record, "failed", { lastError: failure(error) });
        return;
      }
      if (
        !(error instanceof GoBusError) &&
        !(error instanceof CancellationError) &&
        !(error instanceof UserStoreError)
      ) {
        store.transition(record, "uncertain", { lastError: "uncertain" });
        throw error;
      }
    }
    await this.#reconcile(record);
  }
  async #reconcile(record: CancellationRecord): Promise<void> {
    const { account, client, store, now, pollMilliseconds } = this.options;
    try {
      const outcome = await account.query(record.bindingHash, (session) =>
        client.reconcile(session, record.quote),
      );
      switch (outcome.status) {
        case "confirmed":
          store.transition(record, "cancelled", { outcome, lastError: null });
          return;
        case "unknown":
          store.transition(record, "uncertain", {
            lastError: "reconciliation_pending",
            nextCheckAt: now() + pollMilliseconds,
          });
          return;
      }
    } catch (error) {
      store.transition(record, "uncertain", {
        lastError: failure(error),
        nextCheckAt: now() + pollMilliseconds,
      });
    }
  }
  async tick(): Promise<void> {
    for (const record of this.options.store.due()) await this.run(record.id);
  }
  async whenIdle(): Promise<void> {
    await Promise.all(this.#pending.values());
  }
}
