import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import {
  directInput,
  expressBookingFixture,
  expressSpec,
  quotedReference,
} from "./express-booking-fixture";

const active: Awaited<ReturnType<typeof expressBookingFixture>>[] = [];
afterEach(async () => {
  for (const fixture of active.splice(0)) await fixture.close();
});
async function setup() {
  const fixture = await expressBookingFixture();
  active.push(fixture);
  return fixture;
}
const resultSchema = z.object({
  created: z.boolean(),
  booking: z.object({ id: z.uuid(), stage: z.string() }),
});
const mutations = (fixture: Awaited<ReturnType<typeof setup>>) =>
  fixture.calls.filter(({ path }) =>
    ["insertPcpyNo.do", "autoReserve", "insertTckCad_CR.do"].some((endpoint) =>
      path.endsWith(endpoint),
    ),
  );

test("HTTP MCP directly books quoted express passengers and confirms independent tickets", async () => {
  // Given
  const fixture = await setup();
  const tripRef = await quotedReference(fixture.client);
  // When
  const result = await fixture.client.callTool({
    name: "book_trip",
    arguments: directInput(tripRef),
  });
  // Then
  expect(result.isError).not.toBe(true);
  expect(resultSchema.parse(result.structuredContent).booking.stage).toBe("booked");
  expect(mutations(fixture).map(({ path }) => path.split("/").at(-1))).toEqual([
    "insertPcpyNo.do",
    "autoReserve",
    "insertTckCad_CR.do",
  ]);
  expect(
    fixture.calls
      .filter(({ path }) => path.endsWith("inqrPymMnsListAtPym"))
      .map(({ body }) => z.object({ utlzSvcDvsCd: z.string() }).parse(body).utlzSvcDvsCd),
  ).toEqual(["H", "H"]);
  expect(fixture.calls.find(({ path }) => path.endsWith("autoReserve"))?.body).toMatchObject({
    utlzSvcDvsCd: "H",
    productCount: 3,
    productAmount: 34500,
  });
  expect(
    fixture.calls
      .filter(({ path }) => path.includes("/ticket/"))
      .every(
        ({ origin, path }) =>
          origin === "https://exp.tmoney.co.kr" && path.startsWith("/tgm/tgoapp/k5/"),
      ),
  ).toBe(true);
  expect(fixture.calls.at(-1)?.path.endsWith("selectBuyTckListSecu.do")).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /synthetic-express-private|payment-order|express-h1|express-order/,
  );
});

test("HTTP MCP schedules express consent and runner tick completes the quoted booking", async () => {
  // Given
  const fixture = await setup();
  const created = await fixture.client.callTool({
    name: "create_booking_request",
    arguments: expressSpec(),
  });
  const { booking } = resultSchema.parse(created.structuredContent);
  expect(booking.stage).toBe("watching");
  expect(mutations(fixture)).toHaveLength(0);
  // When
  await fixture.first.runner.tick();
  const listed = await fixture.client.callTool({ name: "list_requests", arguments: {} });
  // Then
  expect(listed.structuredContent).toMatchObject({
    bookings: [
      {
        id: booking.id,
        stage: "booked",
        spec: { criteria: { service: "express" } },
        selection: { service: "express", fareKrw: 34500 },
      },
    ],
  });
  expect(mutations(fixture)).toHaveLength(3);
});

test("HTTP MCP idempotent direct retry keeps the booking without another financial mutation", async () => {
  // Given
  const fixture = await setup();
  const input = directInput(await quotedReference(fixture.client));
  const initial = resultSchema.parse(
    (await fixture.client.callTool({ name: "book_trip", arguments: input })).structuredContent,
  );
  expect(initial.booking.stage).toBe("booked");
  // When
  const repeated = resultSchema.parse(
    (await fixture.client.callTool({ name: "book_trip", arguments: input })).structuredContent,
  );
  // Then
  expect(repeated).toEqual({ created: false, booking: initial.booking });
  expect(mutations(fixture)).toHaveLength(3);
});

test("uncertain express issue survives restart and reconciles without a second issue or reserve", async () => {
  // Given
  const fixture = await setup();
  fixture.state.issueFails = true;
  fixture.state.receiptsAvailable = false;
  const input = directInput(await quotedReference(fixture.client));
  const initial = resultSchema.parse(
    (await fixture.client.callTool({ name: "book_trip", arguments: input })).structuredContent,
  );
  expect(initial.booking.stage).toBe("uncertain");
  const replay = resultSchema.parse(
    (await fixture.client.callTool({ name: "book_trip", arguments: input })).structuredContent,
  );
  expect(replay.created).toBe(false);
  fixture.state.receiptsAvailable = true;
  fixture.state.now += 300_000;
  // When
  await fixture.restart();
  await fixture.first.runner.tick();
  const listed = await fixture.client.callTool({ name: "list_requests", arguments: {} });
  // Then
  expect(listed.structuredContent).toMatchObject({
    bookings: [{ id: initial.booking.id, stage: "booked" }],
  });
  expect(mutations(fixture)).toHaveLength(3);
  expect(fixture.calls.filter(({ path }) => path.endsWith("insertTckCad_CR.do"))).toHaveLength(1);
});

test("unavailable express Npay preflight prevents every hold and payment mutation", async () => {
  // Given
  const fixture = await setup();
  fixture.state.paymentAvailable = false;
  const input = directInput(await quotedReference(fixture.client));
  // When
  const result = await fixture.client.callTool({ name: "book_trip", arguments: input });
  // Then
  expect(result.structuredContent).toMatchObject({
    booking: { stage: "failed", lastError: "payment_unavailable" },
  });
  expect(mutations(fixture)).toHaveLength(0);
  expect(
    fixture.calls
      .filter(({ path }) => path.endsWith("inqrPymMnsListAtPym"))
      .map(({ body }) => z.object({ utlzSvcDvsCd: z.string() }).parse(body).utlzSvcDvsCd),
  ).toEqual(["H"]);
});

test("HTTP users cannot reuse another express reference or cancel and list another booking", async () => {
  // Given
  const fixture = await setup();
  const tripRef = await quotedReference(fixture.client);
  const spec = expressSpec();
  const { booking } = resultSchema.parse(
    (await fixture.client.callTool({ name: "create_booking_request", arguments: spec }))
      .structuredContent,
  );
  // When
  const foreign = await fixture.otherClient.callTool({
    name: "book_trip",
    arguments: directInput(tripRef),
  });
  const cancelled = await fixture.otherClient.callTool({
    name: "cancel_booking_request",
    arguments: { bookingId: booking.id },
  });
  const listed = await fixture.otherClient.callTool({
    name: "list_requests",
    arguments: {},
  });
  const independent = resultSchema.parse(
    (await fixture.otherClient.callTool({ name: "create_booking_request", arguments: spec }))
      .structuredContent,
  );
  // Then
  expect(foreign.isError).toBe(true);
  expect(cancelled.structuredContent).toMatchObject({ cancelled: false });
  expect(listed.structuredContent).toEqual({ bookings: [], watches: [], delivery: "inbox_only" });
  expect(independent.created).toBe(true);
  expect(independent.booking.id).not.toBe(booking.id);
  expect(fixture.first.store.get(booking.id)?.stage).toBe("watching");
  expect(mutations(fixture)).toHaveLength(0);
});

test("changed account connection cancels pending express authority before hold", async () => {
  // Given
  const fixture = await setup();
  const { booking } = resultSchema.parse(
    (await fixture.client.callTool({ name: "create_booking_request", arguments: expressSpec() }))
      .structuredContent,
  );
  fixture.state.connection = "express-reconnected";
  // When
  await fixture.first.runner.tick();
  // Then
  expect(fixture.first.store.get(booking.id)).toMatchObject({
    stage: "failed",
    lastError: "account_changed",
  });
  expect(mutations(fixture)).toHaveLength(0);
});

test("prior identical express receipt remains uncertain across restart instead of confirming a new payment", async () => {
  // Given
  const fixture = await setup();
  fixture.state.priorIdenticalReceipt = true;
  const input = directInput(await quotedReference(fixture.client));
  const initial = await fixture.client.callTool({ name: "book_trip", arguments: input });
  const { booking } = resultSchema.parse(initial.structuredContent);
  expect(booking.stage).toBe("uncertain");
  const baseline = fixture.first.store.read(booking.id)?.receiptBaseline;
  expect(baseline?.length).toBeGreaterThan(0);
  expect(JSON.stringify(initial)).not.toContain("express-line");
  fixture.state.now += 300_000;
  // When
  await fixture.restart();
  await fixture.first.runner.tick();
  // Then
  expect(fixture.first.store.read(booking.id)?.receiptBaseline).toEqual(baseline);
  expect(fixture.first.store.get(booking.id)?.stage).toBe("uncertain");
  expect(mutations(fixture)).toHaveLength(3);
  const baselineIndex = fixture.calls.findIndex(({ path }) =>
    path.endsWith("selectBuyTckListSecu.do"),
  );
  const holdIndex = fixture.calls.findIndex(({ path }) => path.endsWith("insertPcpyNo.do"));
  expect(baselineIndex).toBeGreaterThanOrEqual(0);
  expect(baselineIndex).toBeLessThan(holdIndex);
});
