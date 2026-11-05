import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { registerBookingTools } from "../src/booking-tools";
import { registerRequestTools } from "../src/request-tools";
import { TripReferences } from "../src/trip-references";
import { harness, specification, webTrip } from "./booking-fixtures";

test("MCP booking tools validate authorization and persist idempotent create list cancel", async () => {
  const item = harness();
  const server = new McpServer({ name: "booking-test", version: "1" });
  registerRequestTools(server, { bookings: { store: item.store, runner: item.runner } });
  registerBookingTools(
    server,
    { store: item.store, runner: item.runner },
    {
      references: new TripReferences(),
      provider: {
        getSeats: async () => {
          throw new Error("Unexpected quote lookup");
        },
      },
    },
  );
  const client = new Client({ name: "booking-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
      "book_trip",
      "cancel_booking_request",
      "create_booking_request",
      "list_requests",
    ]);
    const spec = specification();
    const invalid = await client.callTool({
      name: "create_booking_request",
      arguments: { ...spec, criteria: { ...spec.criteria, maxFareKrw: undefined } },
    });
    expect(invalid.isError).toBe(true);
    const injected = await client.callTool({
      name: "create_booking_request",
      arguments: { ...spec, userId: crypto.randomUUID() },
    });
    expect(injected.isError).toBe(true);
    const created = await client.callTool({ name: "create_booking_request", arguments: spec });
    expect(created.isError).not.toBe(true);
    const duplicate = await client.callTool({ name: "create_booking_request", arguments: spec });
    expect(duplicate.structuredContent).toMatchObject({ created: false });
    expect(item.store.list()).toHaveLength(1);
    const booking = item.store.list()[0];
    if (!booking) throw new TypeError("Missing booking");
    expect(
      (await client.callTool({ name: "list_requests", arguments: {} })).structuredContent,
    ).toEqual({ watches: [], bookings: item.store.list(), delivery: "inbox_only" });
    const cancelled = await client.callTool({
      name: "cancel_booking_request",
      arguments: { bookingId: booking.id },
    });
    expect(cancelled.structuredContent).toMatchObject({ cancelled: true });
    expect(item.store.get(booking.id)?.stage).toBe("cancelled");
  } finally {
    await client.close();
    await server.close();
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

test("MCP rejects missing or unsupported payment before any financial mutation", async () => {
  // Given
  const item = harness();
  const server = new McpServer({ name: "booking-test", version: "1" });
  registerBookingTools(
    server,
    { store: item.store, runner: item.runner },
    {
      references: new TripReferences(),
      provider: {
        getSeats: async () => {
          throw new Error("Unexpected quote lookup");
        },
      },
    },
  );
  const client = new Client({ name: "booking-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    // When
    const outcomes = await Promise.all(
      [undefined, { method: "card" }].map((payment) =>
        client.callTool({
          name: "create_booking_request",
          arguments: { ...specification(), payment },
        }),
      ),
    );
    // Then
    expect(outcomes.every((result) => result.isError === true)).toBe(true);
    expect(item.store.list()).toHaveLength(0);
    expect(item.actions).toEqual([]);
  } finally {
    await client.close();
    await server.close();
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});

test("MCP exact booking executes its referenced trip without searching alternatives", async () => {
  // Given
  const item = harness();
  const references = new TripReferences();
  const tripRef = references.add(webTrip);
  item.state.available = false;
  const server = new McpServer({ name: "booking-test", version: "1" });
  registerBookingTools(
    server,
    { store: item.store, runner: item.runner },
    {
      references,
      provider: {
        getSeats: async () => {
          throw new Error("Unexpected quote lookup");
        },
      },
    },
  );
  const client = new Client({ name: "booking-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(right);
    await client.connect(left);
    const spec = specification();
    // When
    const response = await client.callTool({
      name: "book_trip",
      arguments: {
        version: 2,
        tripRef,
        idempotencyKey: spec.idempotencyKey,
        passengers: spec.criteria.passengers,
        payment: spec.payment,
        discounts: spec.discounts,
        seatPolicy: spec.seatPolicy,
        maxFareKrw: spec.criteria.maxFareKrw,
        intervalSeconds: spec.intervalSeconds,
        expiresAt: spec.expiresAt,
      },
    });
    // Then
    expect(response.isError).not.toBe(true);
    expect(item.store.list()[0]?.stage).toBe("booked");
    expect(item.actions.some(({ action }) => action === "scan")).toBe(false);
    expect(item.store.records()[0]?.exactTrip?.tripKey).toBe(webTrip.tripKey);
  } finally {
    await client.close();
    await server.close();
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});
