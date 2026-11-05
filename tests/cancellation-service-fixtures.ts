import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CancellationService } from "../src/cancellation-service";
import { CancellationStore } from "../src/cancellation-store";
import { UserCredentialStore } from "../src/user-credentials";
import { UserStore } from "../src/user-store";
import { credentials } from "./booking-fixtures";
import { account, type FixtureEdit, fixture, now } from "./go-ticket-fixtures";

export function serviceFixture(service: "intercity" | "express", edit?: FixtureEdit) {
  const directory = mkdtempSync(join(tmpdir(), "cancellation-service-"));
  const users = new UserStore(join(directory, "users.sqlite"));
  const input = {
    ...credentials,
    ...account.context.session,
    moappMbrsSno: account.memberSerialNumber,
    busUserNumber: account.context.userNumber,
  };
  const user = users.connect(input);
  const adapter = new UserCredentialStore(users, user.userId);
  const path = join(directory, "bookings.sqlite");
  const store = new CancellationStore(path, user.userId, { now: () => now });
  const native = fixture(service, edit);
  const options = { store, credentials: adapter, client: native.client, now: () => now };
  const cancellation = new CancellationService(options);
  const stores = [store];
  return {
    path,
    users,
    user,
    input,
    native,
    store,
    cancellation,
    async authorize(
      selection:
        | { readonly mode: "all" }
        | { readonly mode: "seats"; readonly seats: readonly number[] } = { mode: "all" },
    ) {
      const listed = await cancellation.listTickets(service);
      const ticket = listed.tickets[0];
      if (!ticket) throw new Error("Synthetic ticket missing");
      const quote = await cancellation.quote(ticket.ticketRef, selection);
      return {
        quoteRef: quote.quoteRef,
        acceptedFeeKrw: quote.feeKrw,
        idempotencyKey: crypto.randomUUID(),
      };
    },
    reopen() {
      const reopened = new CancellationStore(path, user.userId, { now: () => now });
      stores.push(reopened);
      return new CancellationService({ ...options, store: reopened });
    },
    mutations() {
      return native.requests.filter((request) => request.url.endsWith("/insertTckCanCad2.do"));
    },
    async [Symbol.asyncDispose]() {
      await cancellation.whenIdle();
      for (const entry of stores) entry.close();
      users.close();
      rmSync(directory, { recursive: true });
    },
  };
}
