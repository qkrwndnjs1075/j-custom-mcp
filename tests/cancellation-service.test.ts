import { expect, test } from "bun:test";
import { bookingBinding } from "../src/booking-types";
import { serviceFixture } from "./cancellation-service-fixtures";

test.each(["intercity", "express"] as const)(
  "%s confirms full cancellation with one mutation across concurrent replay",
  async (service) => {
    // Given
    await using item = serviceFixture(service);
    const spec = await item.authorize();
    // When
    const results = await Promise.all([
      item.cancellation.cancel(spec),
      item.cancellation.cancel(spec),
    ]);
    // Then
    expect(results.map((result) => result.cancellation.stage)).toEqual(["cancelled", "cancelled"]);
    expect(item.mutations()).toHaveLength(1);
    expect(JSON.stringify(results)).not.toMatch(
      /issuance-|order-1|line-1|member-fixture|Authorization|payload/,
    );
  },
);
test.each(["intercity", "express"] as const)(
  "%s cancels selected seat while preserving remaining ticket",
  async (service) => {
    // Given
    await using item = serviceFixture(service);
    const spec = await item.authorize({ mode: "seats", seats: [2] });
    // When
    const result = await item.cancellation.cancel(spec);
    // Then
    expect(result.cancellation.stage).toBe("cancelled");
    expect(result.cancellation.seats).toEqual([2]);
    expect(item.native.state.seats).toEqual([2]);
  },
);
test("stops before mutation when the fresh fee changes", async () => {
  // Given
  let reads = 0;
  await using item = serviceFixture("express", (path, response) =>
    path === "selectFeeInfo.do" && ++reads > 1 ? { ...response, canFee: "2000" } : response,
  );
  const spec = await item.authorize();
  // When
  const result = await item.cancellation.cancel(spec);
  // Then
  expect(result.cancellation.stage).toBe("failed");
  expect(result.cancellation.lastError).toBe("fee_changed");
  expect(item.mutations()).toHaveLength(0);
});
test("uses history proof after cancellation response is lost", async () => {
  // Given
  await using item = serviceFixture("express", (path, response) => {
    if (path === "insertTckCanCad2.do") throw new TypeError("synthetic lost response");
    return response;
  });
  const spec = await item.authorize();
  // When
  const result = await item.cancellation.cancel(spec);
  // Then
  expect(result.cancellation.stage).toBe("cancelled");
  expect(item.mutations()).toHaveLength(1);
});
test("never resubmits an uncertain cancellation after restart", async () => {
  // Given
  await using item = serviceFixture("express", (path, response) =>
    path === "selectMyPagePayInfo2.do" ? new Response(null, { status: 503 }) : response,
  );
  const spec = await item.authorize();
  await item.cancellation.cancel(spec);
  const restarted = item.reopen();
  // When
  const result = await restarted.cancel(spec);
  // Then
  expect(result.cancellation.stage).toBe("uncertain");
  expect(item.mutations()).toHaveLength(1);
});
test("rejects a quote after the same account reconnects", async () => {
  // Given
  await using item = serviceFixture("express");
  const spec = await item.authorize();
  item.users.connect(item.input);
  // When / Then
  await expect(item.cancellation.cancel(spec)).rejects.toThrow("account_changed");
  expect(item.mutations()).toHaveLength(0);
});
test("rejects ticket history when the account reconnects before the response returns", async () => {
  let reconnect = () => {};
  await using item = serviceFixture("express", (path, response) => {
    if (path.startsWith("selectMyPagePayList")) reconnect();
    return response;
  });
  reconnect = () => {
    item.users.connect(item.input);
  };
  await expect(item.cancellation.listTickets("express")).rejects.toThrow("account_changed");
  expect(item.mutations()).toHaveLength(0);
});
test("rejects a ticket reference after the account reconnects", async () => {
  await using item = serviceFixture("express");
  const listed = await item.cancellation.listTickets("express");
  const reference = listed.tickets[0];
  if (!reference) throw new Error("Synthetic ticket missing");
  item.users.connect(item.input);
  await expect(item.cancellation.quote(reference.ticketRef, { mode: "all" })).rejects.toThrow(
    "account_changed",
  );
  expect(item.native.requests).toHaveLength(1);
  expect(item.mutations()).toHaveLength(0);
});
test("stops when account reconnects during final preflight", async () => {
  // Given
  let reads = 0;
  let reconnect = () => {};
  await using item = serviceFixture("express", (path, response) => {
    if (path === "selectFeeInfo.do" && ++reads > 1) reconnect();
    return response;
  });
  reconnect = () => {
    item.users.connect(item.input);
  };
  const spec = await item.authorize();
  // When
  const result = await item.cancellation.cancel(spec);
  // Then
  expect(result.cancellation.lastError).toBe("account_changed");
  expect(item.mutations()).toHaveLength(0);
});
test("reports actual provider fee independently from accepted preflight fee", async () => {
  // Given
  await using item = serviceFixture("express", (path, response) =>
    path === "selectMyPagePayInfo2.do"
      ? { ...response, PEP_CHA: "2000", CAN_FEE: "18000" }
      : response,
  );
  const spec = await item.authorize();
  // When
  const result = await item.cancellation.cancel(spec);
  // Then
  expect(result.cancellation.stage).toBe("cancelled");
  expect(result.cancellation.feeChanged).toBe(true);
  expect(result.cancellation.actualFeeKrw).toBe(2000);
  expect(result.refundSettlement).toBe("unverified");
});
test("does not submit prepared work from background scheduler", async () => {
  // Given
  await using item = serviceFixture("express");
  const spec = await item.authorize();
  const current = item.users.read(item.user.userId);
  item.store.create(
    spec,
    bookingBinding({ ...current.credentials, connectionId: current.connectionId }),
  );
  // When
  await item.cancellation.tick();
  // Then
  expect(item.mutations()).toHaveLength(0);
});
