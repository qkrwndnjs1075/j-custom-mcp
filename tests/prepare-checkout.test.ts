import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { TmoneyIntercityClient } from "../src/provider";
import { parseTrips } from "../src/provider-html";
import { SeatMapSchema } from "../src/provider-types";
import { createBusServer } from "../src/tools";
import { TripReferences } from "../src/trip-references";

const [trip] = parseTrips(
  await Bun.file(new URL("fixtures/dispatch.html", import.meta.url)).text(),
);
if (!trip) throw new Error("Missing provider fixture trip");

test.each([
  { fare: 13700, available: true, expectedError: false },
  { fare: 17000, available: true, expectedError: true },
  { fare: 13700, available: false, expectedError: true },
])("prepares checkout only within the live fare and seat constraints: %j", async (scenario) => {
  class SeatProvider extends TmoneyIntercityClient {
    override async getSeats() {
      return SeatMapSchema.parse({
        adultFareKrw: scenario.fare,
        seats: [{ number: 8, available: scenario.available }],
      });
    }
  }
  const references = new TripReferences(() => 0);
  const tripRef = references.add(trip);
  const server = createBusServer({
    provider: new SeatProvider(),
    references,
    checkoutBaseUrl: new URL("https://bus.example.com"),
  });
  const client = new Client({ name: "checkout-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({
      name: "prepare_checkout",
      arguments: { tripRef, maxFareKrw: 16000, payment: { method: "official_card" } },
    });
    expect(result.isError === true).toBe(scenario.expectedError);
    if (!scenario.expectedError) {
      expect(result.structuredContent).toMatchObject({
        status: "requires_user_checkout",
        payment: { method: "official_card" },
        executionMode: "user_checkout",
        checkoutUrl: `https://bus.example.com/checkout/${tripRef}`,
        quotedFareKrw: 13700,
      });
    }
  } finally {
    await client.close();
  }
});

test.each([
  { cap: 20000, available: 3, expectedError: true },
  { cap: 30000, available: 2, expectedError: true },
  { cap: 30000, available: 3, expectedError: false },
])(
  "mixed checkout requires full-party capacity and total fare within cap: %j",
  async (scenario) => {
    // Given: three passengers with individually returned provider fares.
    class MixedSeatProvider extends TmoneyIntercityClient {
      override async getSeats() {
        return SeatMapSchema.parse({
          adultFareKrw: 12000,
          fareQuotes: {
            adults: { unitFareKrw: 12000, fareKindCode: "IG00" },
            students: { unitFareKrw: 9000, fareKindCode: "IM20" },
            children: { unitFareKrw: 4000, fareKindCode: "IC50" },
          },
          seats: [1, 2, 3].map((number) => ({ number, available: number <= scenario.available })),
        });
      }
    }
    const references = new TripReferences(() => 0);
    const tripRef = references.add({
      ...trip,
      adultCount: 1,
      studentCount: 1,
      childCount: 1,
      passengers: { adults: 1, students: 1, children: 1 },
    });
    const server = createBusServer({
      provider: new MixedSeatProvider(),
      references,
      checkoutBaseUrl: new URL("https://bus.example.com"),
    });
    const client = new Client({ name: "mixed-checkout", version: "1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      // When: prepare checkout through the MCP protocol.
      const result = await client.callTool({
        name: "prepare_checkout",
        arguments: { tripRef, maxFareKrw: scenario.cap, payment: { method: "official_card" } },
      });
      // Then: both group capacity and group price govern acceptance.
      expect(result.isError === true).toBe(scenario.expectedError);
      if (!scenario.expectedError)
        expect(result.structuredContent).toMatchObject({
          totalFareKrw: 25000,
          passengers: { adults: 1, students: 1, children: 1 },
        });
    } finally {
      await client.close();
    }
  },
);
