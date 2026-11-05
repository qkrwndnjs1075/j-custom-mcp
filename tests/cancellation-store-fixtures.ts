import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancellationStore } from "../src/cancellation-store";
import type { CancellationSpec } from "../src/cancellation-types";
import { DEFAULT_SERVICE_LIMITS } from "../src/service-limits";
import { account, fixture, now, ticket } from "./go-ticket-fixtures";

export const binding = "b".repeat(64);
export async function cancellationHarness(service: "intercity" | "express" = "express") {
  const native = fixture(service);
  const quote = await native.client.quote(account, {
    ticket: ticket(service),
    selection: { mode: "all" },
  });
  const directory = mkdtempSync(join(tmpdir(), "cancellation-store-"));
  const path = join(directory, "bookings.sqlite");
  const state = { now };
  const options = {
    now: () => state.now,
    limits: {
      ...DEFAULT_SERVICE_LIMITS,
      cancellationQuotes: 3,
      cancellationQuoteTtlSeconds: 120,
      activeCancellations: 2,
      retainedCancellations: 3,
    },
  };
  const store = new CancellationStore(path, "synthetic-principal", options);
  const saved = store.saveQuote(binding, quote);
  const spec: CancellationSpec = {
    quoteRef: saved.id,
    idempotencyKey: crypto.randomUUID(),
    acceptedFeeKrw: quote.feeKrw,
  };
  const connections = [store];
  return {
    directory,
    path,
    state,
    options,
    store,
    quote,
    saved,
    spec,
    reopen() {
      const connection = new CancellationStore(path, "synthetic-principal", options);
      connections.push(connection);
      return connection;
    },
    dispose() {
      for (const connection of connections) connection.close();
      rmSync(directory, { recursive: true });
    },
  };
}
