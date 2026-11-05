import { expect, test } from "bun:test";
import { bookingBinding } from "../src/booking-types";
import { GoBusError } from "../src/go-bus-types";
import { credentials } from "./booking-fixtures";
import { account, fixture, rotatingIntercityFixture } from "./go-ticket-fixtures";

for (const service of ["intercity", "express"] as const) {
  test(`${service} quotes a listed ticket when request and response owners differ`, async () => {
    // Given
    const fake = service === "intercity" ? rotatingIntercityFixture() : fixture(service);
    const [ticket] = await fake.client.list(account, service);
    if (!ticket) throw new TypeError("Missing ticket");
    expect(ticket.ownerUserNumber).not.toBe(account.context.userNumber);
    // When
    const quote = await fake.client.quote(account, { ticket, selection: { mode: "all" } });
    // Then
    expect(quote.refundKrw).toBe(19000);
    expect(fake.requests.some((request) => request.url.includes("insert"))).toBe(false);
  });

  test(`${service} refuses a legacy unbound snapshot before mutation or reconciliation`, async () => {
    // Given
    const fake = service === "intercity" ? rotatingIntercityFixture() : fixture(service);
    const [ticket] = await fake.client.list(account, service);
    if (!ticket) throw new TypeError("Missing ticket");
    const quote = await fake.client.quote(account, { ticket, selection: { mode: "all" } });
    const { accountBinding: _binding, ...legacyTicket } = ticket;
    const legacy = { ...quote, ticket: legacyTicket };
    fake.state.cancelled = true;
    const before = fake.requests.length;
    // When / Then
    await expect(fake.client.cancel(account, legacy)).rejects.toEqual(new GoBusError("input"));
    expect(await fake.client.reconcile(account, legacy)).toEqual({ status: "unknown" });
    expect(fake.requests).toHaveLength(before);
  });

  for (const change of ["account", "connection"] as const) {
    const changed = {
      ...account,
      bindingHash: bookingBinding({
        moappMbrsSno: change === "account" ? "other-member" : account.memberSerialNumber,
        busUserNumber: account.context.userNumber,
        connectionId: change === "connection" ? "new-connection" : credentials.connectionId,
      }),
    };
    test(`${service} rejects another ${change} before quoting a listed ticket`, async () => {
      // Given
      const fake = service === "intercity" ? rotatingIntercityFixture() : fixture(service);
      const [ticket] = await fake.client.list(account, service);
      if (!ticket) throw new TypeError("Missing ticket");
      const before = fake.requests.length;
      // When / Then
      await expect(
        fake.client.quote(changed, { ticket, selection: { mode: "all" } }),
      ).rejects.toEqual(new GoBusError("input"));
      expect(fake.requests).toHaveLength(before);
    });
    test(`${service} rejects another ${change} before submitting cancellation`, async () => {
      // Given
      const fake = service === "intercity" ? rotatingIntercityFixture() : fixture(service);
      const [ticket] = await fake.client.list(account, service);
      if (!ticket) throw new TypeError("Missing ticket");
      const quote = await fake.client.quote(account, { ticket, selection: { mode: "all" } });
      const before = fake.requests.length;
      // When / Then
      await expect(fake.client.cancel(changed, quote)).rejects.toEqual(new GoBusError("input"));
      expect(fake.requests).toHaveLength(before);
    });
    test(`${service} cannot reconcile another ${change} using identical response rows`, async () => {
      // Given
      const fake = service === "intercity" ? rotatingIntercityFixture() : fixture(service);
      const [ticket] = await fake.client.list(account, service);
      if (!ticket) throw new TypeError("Missing ticket");
      const quote = await fake.client.quote(account, { ticket, selection: { mode: "all" } });
      fake.state.cancelled = true;
      const before = fake.requests.length;
      // When
      const result = await fake.client.reconcile(changed, quote);
      // Then
      expect(result).toEqual({ status: "unknown" });
      expect(fake.requests).toHaveLength(before);
    });
  }
}
