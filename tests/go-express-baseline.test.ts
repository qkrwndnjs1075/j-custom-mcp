import { afterEach, expect, test } from "bun:test";
import { context, fixture, identity, lookup, stopFixtures } from "./go-express-fixtures";

afterEach(stopFixtures);

test("captures express active ticket IDs before mutation using the native full-list request", async () => {
  const fake = fixture();
  const baseline = await fake.purchase.captureReceiptBaseline(context, "express-member", "express");
  expect(baseline).toEqual([identity.LIN_SNO]);
  expect(fake.requests).toHaveLength(1);
  const request = fake.requests[0];
  if (!request) throw new Error("Expected baseline request");
  expect(new URL(request.url).pathname).toBe("/tgm/tgoapp/k5/ticket/selectBuyTckListSecu.do");
  expect(await request.json()).toMatchObject({
    usr_sno: context.userNumber,
    mem_sno: "express-member",
    hp_syn_yn: "N",
    arpr_trml_yn: "N",
  });
});

test("captures no intercity baseline and makes no request", async () => {
  const fake = fixture();
  expect(await fake.purchase.captureReceiptBaseline(context, "member", "intercity")).toEqual([]);
  expect(fake.requests).toHaveLength(0);
});

for (const [name, payload] of [
  ["missing list", {}],
  ["null list", { ticketList: null }],
  ["missing ticket ID", { ticketList: [{}] }],
  ["empty ticket ID", { ticketList: [{ linSno: "" }] }],
  ["duplicate ticket IDs", { ticketList: [{ linSno: "old" }, { LIN_SNO: "old" }] }],
  ["conflicting ID aliases", { ticketList: [{ linSno: "old", LIN_SNO: "other" }] }],
  ["conflicting list aliases", { ticketList: [], TICKET_LIST: [{ linSno: "old" }] }],
] as const) {
  test(`rejects express baseline with ${name} without mutation`, async () => {
    const fake = fixture(() => Response.json({ errCode: "00000", ...payload }));
    await expect(
      fake.purchase.captureReceiptBaseline(context, "member", "express"),
    ).rejects.toMatchObject({ code: "response" });
    expect(fake.requests).toHaveLength(1);
  });
}

test("accepts an explicitly empty native active-ticket list", async () => {
  const fake = fixture(() => Response.json({ errCode: "00000", ticketList: [] }));
  expect(await fake.purchase.captureReceiptBaseline(context, "member", "express")).toEqual([]);
});

test("does not retry failed baseline reads", async () => {
  const fake = fixture(() => new Response("unavailable", { status: 503 }));
  await expect(
    fake.purchase.captureReceiptBaseline(context, "member", "express"),
  ).rejects.toBeDefined();
  expect(fake.requests).toHaveLength(1);
});

test("does not confirm an already active express ticket even when all receipt fields match", async () => {
  const fake = fixture();
  expect(
    await fake.purchase.reconcile(context, { ...lookup, receiptBaseline: [identity.LIN_SNO] }),
  ).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(1);
});

test("requires a persisted express receipt baseline and never infers an empty one", async () => {
  const fake = fixture();
  const { receiptBaseline: _baseline, ...missingBaseline } = lookup;
  expect(await fake.purchase.reconcile(context, missingBaseline)).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(0);
});

test("rejects malformed duplicate persisted receipt baselines before inquiry", async () => {
  const fake = fixture();
  expect(
    await fake.purchase.reconcile(context, { ...lookup, receiptBaseline: ["old", "old"] }),
  ).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(0);
});

test("confirms a new express ticket absent from the captured baseline", async () => {
  const fake = fixture();
  expect(
    await fake.purchase.reconcile(context, { ...lookup, receiptBaseline: ["prior-other-ticket"] }),
  ).toMatchObject({ status: "confirmed", ticketNumber: identity.LIN_SNO });
  expect(fake.requests).toHaveLength(4);
});
