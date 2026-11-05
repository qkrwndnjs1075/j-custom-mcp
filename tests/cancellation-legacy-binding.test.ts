import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { bookingBinding } from "../src/booking-types";
import { serviceFixture } from "./cancellation-service-fixtures";

test.each(["prepared", "submitting", "uncertain", "cancelled", "failed"] as const)(
  "retains legacy %s history on restart without granting provider authority",
  async (stage) => {
    // Given
    await using item = serviceFixture("express");
    const spec = await item.authorize();
    const current = item.users.read(item.user.userId);
    const binding = bookingBinding({ ...current.credentials, connectionId: current.connectionId });
    const record = item.store.create(spec, binding).record;
    const { accountBinding: _binding, ...ticket } = record.quote.ticket;
    const quote = { ...record.quote, ticket };
    const legacy = {
      ...record,
      quote,
      stage,
      ...(stage === "cancelled"
        ? {
            outcome: {
              status: "confirmed",
              feeKrw: 1000,
              refundKrw: 19000,
              cancelledAt: "2026-10-24T12:00:01+09:00",
            },
          }
        : {}),
    };
    const db = new Database(item.path);
    try {
      db.query("UPDATE cancellations SET stage=?,record=? WHERE id=?").run(
        stage,
        JSON.stringify(legacy),
        record.id,
      );
      const storedQuote = item.store.getQuote(spec.quoteRef);
      if (!storedQuote) throw new TypeError("Missing quote");
      const legacyQuote = JSON.stringify({ ...storedQuote, quote });
      db.query("UPDATE cancellation_quotes SET record=? WHERE id=?").run(
        legacyQuote,
        spec.quoteRef,
      );
      const before = item.native.requests.length;
      // When
      const restarted = item.reopen();
      const result = await restarted.cancel(spec);
      // Then
      const expected =
        stage === "prepared" ? "failed" : stage === "submitting" ? "uncertain" : stage;
      expect(result.cancellation.stage).toBe(expected);
      expect(item.store.list()).toHaveLength(1);
      expect(item.native.requests).toHaveLength(before);
      expect(item.mutations()).toHaveLength(0);
      expect(
        db
          .query<{ readonly record: string }, [string]>(
            "SELECT record FROM cancellation_quotes WHERE id=?",
          )
          .get(spec.quoteRef)?.record,
      ).toBe(legacyQuote);
    } finally {
      db.close();
    }
  },
);
