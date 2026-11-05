import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import ky from "ky";
import { z } from "zod";
import { directInput, expressSearch, expressSpec } from "../tests/express-booking-inputs";
import { startSandboxServer } from "./sandbox-server";

type Step = {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly result: Record<string, unknown>;
};

const object = z.record(z.string(), z.unknown());
const identified = z.object({ id: z.uuid() });
const tripList = z.object({ trips: z.array(z.object({ tripRef: z.uuid() })).min(1) });

/** Runs only against the isolated synthetic server; records MCP inputs and public outputs. */
export async function runWalkthrough(url: URL) {
  assert.equal(url.hostname, "127.0.0.1", "Walkthrough requires the loopback sandbox");
  z.object({ mode: z.literal("synthetic"), liveFinancialCalls: z.literal(0) }).parse(
    await ky.get(new URL("/health", url), { retry: 0, timeout: 5000 }).json(),
  );
  const client = new Client({ name: "sandbox-walkthrough", version: "1" });
  // Accumulate the ordered instructions for replay in Inspector.
  const steps: Step[] = [];
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response.content)}`);
    const result = object.parse(response.structuredContent);
    steps.push({ name, arguments: args, result });
    return result;
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(url));
    const inventory = (await client.listTools()).tools.map(({ name }) => name).sort();
    assert.equal(inventory.length, 17);
    z.object({ service: z.literal("tmoney_go_bus") }).parse(
      await call("get_service_capabilities", {}),
    );
    z.object({ terminals: z.array(object).min(1) }).parse(
      await call("search_terminals", { service: "express", query: "센트럴" }),
    );
    const { trips } = tripList.parse(await call("search_trips", expressSearch));
    const tripRef = trips[0]?.tripRef;
    assert.ok(tripRef);
    z.object({ totalFareKrw: z.literal(34500) }).parse(await call("get_seats", { tripRef }));
    z.object({ connection: z.literal("connected") }).parse(
      await call("get_payment_options", { service: "express" }),
    );
    const spec = expressSpec();
    z.object({ journeys: z.array(object).min(1) }).parse(
      await call("find_journeys", {
        legs: [spec.criteria],
        ranking: ["total_fare"],
        maxResults: 5,
      }),
    );
    z.object({ status: z.literal("requires_user_checkout") }).parse(
      await call("prepare_checkout", {
        tripRef,
        maxFareKrw: 34500,
        payment: { method: "official_card" },
      }),
    );
    const { watch } = z.object({ watch: identified }).parse(
      await call("watch_trips", {
        mode: "seats_available",
        criteria: spec.criteria,
        intervalSeconds: spec.intervalSeconds,
        expiresAt: spec.expiresAt,
        notification: "on_transition",
        retryPolicy: { mode: "fixed_interval" },
      }),
    );
    z.object({ alerts: z.array(z.object({ watchId: z.literal(watch.id) })).min(1) }).parse(
      await call("check_alerts", { after: 0, limit: 100 }),
    );
    z.object({ cancelled: z.literal(true) }).parse(
      await call("cancel_watch", { watchId: watch.id }),
    );
    const pending = z
      .object({ booking: identified.extend({ stage: z.literal("watching") }) })
      .parse(
        await call("create_booking_request", {
          ...spec,
          criteria: { ...spec.criteria, maxFareKrw: 1 },
        }),
      );
    z.object({ cancelled: z.literal(true) }).parse(
      await call("cancel_booking_request", { bookingId: pending.booking.id }),
    );
    const booked = z
      .object({ booking: identified.extend({ stage: z.literal("booked") }) })
      .parse(await call("book_trip", directInput(tripRef)));
    const requests = z
      .object({ bookings: z.array(identified.extend({ stage: z.string() })) })
      .parse(await call("list_requests", {}));
    assert.ok(
      requests.bookings.some(
        (booking) => booking.id === booked.booking.id && booking.stage === "booked",
      ),
    );
    assert.ok(
      requests.bookings.some(
        (booking) => booking.id === pending.booking.id && booking.stage === "cancelled",
      ),
    );
    const tickets = z
      .object({ tickets: z.array(z.object({ ticketRef: z.uuid() })).min(1) })
      .parse(await call("list_tickets", { service: "intercity" }));
    const ticketRef = tickets.tickets[0]?.ticketRef;
    assert.ok(ticketRef);
    const quote = z
      .object({ quoteRef: z.uuid(), feeKrw: z.number() })
      .parse(await call("get_cancellation_quote", { ticketRef, selection: { mode: "all" } }));
    z.object({ cancellation: z.object({ stage: z.literal("cancelled") }) }).parse(
      await call("cancel_ticket", {
        quoteRef: quote.quoteRef,
        acceptedFeeKrw: quote.feeKrw,
        idempotencyKey: crypto.randomUUID(),
      }),
    );
    assert.deepEqual([...new Set(steps.map(({ name }) => name))].sort(), inventory);
    return {
      synthetic: true,
      endpoint: url.href,
      toolCount: inventory.length,
      tools: inventory,
      note: "합성 데이터 전용. 각 단계의 UUID는 해당 실행의 응답에서 가져옵니다. 공식 결제 링크를 열어도 결제가 완료된 것은 아닙니다.",
      steps,
    };
  } finally {
    await client.close();
  }
}

if (import.meta.main) {
  const sandbox = await startSandboxServer({ port: 0 });
  try {
    const report = await runWalkthrough(sandbox.url);
    const output = process.argv[2] ?? "/tmp/tmoney-sandbox-walkthrough.json";
    await Bun.write(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`17/17 도구 성공: ${output}`);
  } finally {
    await sandbox.close();
  }
}
