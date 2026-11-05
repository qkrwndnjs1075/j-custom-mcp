import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { ProviderError, TmoneyIntercityClient } from "../src/provider";
import { SeatMapSchema, TripSchema } from "../src/provider-types";
import { createBusServer } from "../src/tools";
import { TripReferences } from "../src/trip-references";

const trip = TripSchema.parse({
  service: "intercity",
  routeId: "route",
  routeSequence: "1",
  serviceDate: "20260101",
  serviceSequence: "1",
  departureId: "0000001",
  arrivalId: "0000002",
  departureName: "Departure",
  arrivalName: "Arrival",
  scheduledDepartureTime: "120000",
  carrierId: "carrier",
  busClassId: "class",
  carrierName: "Carrier",
  busClassName: "Standard",
  adultCount: 1,
  studentCount: 0,
  childCount: 0,
  remainingSeats: 10,
  totalSeats: 40,
  departureDate: "20260101",
  departureTime: "120000",
  discountAvailable: "N",
  adultFareKrw: 10000,
});

class ProviderRequestGuard extends TmoneyIntercityClient {
  calls = 0;
  override async searchTerminals(): Promise<never> {
    this.calls++;
    throw new ProviderError("network", "Unexpected provider request");
  }
  override async searchTripPage(): Promise<never> {
    this.calls++;
    throw new ProviderError("network", "Unexpected provider request");
  }
  override async getSeats(): Promise<never> {
    this.calls++;
    throw new ProviderError("network", "Unexpected provider request");
  }
}

async function connect(references = new TripReferences()) {
  const provider = new ProviderRequestGuard();
  const server = createBusServer({ provider, references });
  const client = new Client({ name: "tool-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, provider };
}

describe("trip reference lifecycle", () => {
  test("returns the original trip while a reference is fresh", () => {
    let now = 0;
    const references = new TripReferences(() => now);
    const reference = references.add(trip);
    now = 15 * 60_000 - 1;
    expect(references.get(reference)).toBe(trip);
  });

  test("rejects a reference at its expiry boundary", () => {
    let now = 0;
    const references = new TripReferences(() => now);
    const reference = references.add(trip);
    now = 15 * 60_000;
    expect(references.get(reference)).toBeUndefined();
  });

  test("rejects an invented reference", () => {
    const references = new TripReferences(() => 0);
    expect(references.get(crypto.randomUUID())).toBeUndefined();
  });

  test("evicts the oldest reference when capacity is exceeded", () => {
    const references = new TripReferences(() => 0);
    const oldest = references.add(trip);
    const second = references.add(trip);
    for (let index = 0; index < 998; index++) references.add(trip);
    const newest = references.add(trip);
    expect(references.get(oldest)).toBeUndefined();
    expect(references.get(second)).toBe(trip);
    expect(references.get(newest)).toBe(trip);
  });
});

describe("bus MCP tool boundary", () => {
  test("lists lookup and journey tools", async () => {
    const { client, provider } = await connect();
    try {
      const result = await client.listTools();
      expect(result.tools.map((tool) => tool.name).sort()).toEqual([
        "find_journeys",
        "get_payment_options",
        "get_seats",
        "get_service_capabilities",
        "search_terminals",
        "search_trips",
      ]);
      expect(provider.calls).toBe(0);
    } finally {
      await client.close();
    }
  });

  test.each([
    { name: "search_terminals", arguments: { query: "   " } },
    { name: "search_terminals", arguments: { query: "Seoul", departureId: "invalid" } },
    {
      name: "search_trips",
      arguments: { departureId: "0000001", arrivalId: "0000002", date: "2026-02-30" },
    },
    {
      name: "search_trips",
      arguments: {
        departureId: "0000001",
        arrivalId: "0000002",
        date: "2026-01-01",
        time: "25:00",
      },
    },
    { name: "get_seats", arguments: { tripRef: "invented" } },
  ])("rejects invalid input before provider access: %j", async (input) => {
    const { client, provider } = await connect();
    try {
      const result = await client.callTool(input);
      expect(result.isError).toBe(true);
      expect(provider.calls).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("rejects an unknown UUID without requesting provider seats", async () => {
    const { client, provider } = await connect();
    try {
      const result = await client.callTool({
        name: "get_seats",
        arguments: { tripRef: crypto.randomUUID() },
      });
      expect(result.isError).toBe(true);
      expect(provider.calls).toBe(0);
    } finally {
      await client.close();
    }
  });

  test("rejects an expired UUID without requesting provider seats", async () => {
    let now = 0;
    const references = new TripReferences(() => now);
    const tripRef = references.add(trip);
    const { client, provider } = await connect(references);
    now = 15 * 60_000;
    try {
      const result = await client.callTool({ name: "get_seats", arguments: { tripRef } });
      expect(result.isError).toBe(true);
      expect(provider.calls).toBe(0);
    } finally {
      await client.close();
    }
  });
});

test("get_seats refreshes the same mixed trip reference without extending its expiry", async () => {
  // Given: an unquoted mixed trip reference and a provider with actual category fares.
  let now = 0;
  const references = new TripReferences(() => now);
  const mixed = TripSchema.parse({ ...trip, adultCount: 1, studentCount: 1, childCount: 1 });
  const tripRef = references.add(mixed);
  expect(references.get(tripRef)?.totalFareKrw).toBeNull();
  class MixedProvider extends TmoneyIntercityClient {
    override async getSeats() {
      return SeatMapSchema.parse({
        adultFareKrw: 10000,
        fareQuotes: {
          adults: { unitFareKrw: 10000, fareKindCode: "IG00" },
          students: { unitFareKrw: 8000, fareKindCode: "IM20" },
          children: { unitFareKrw: 5000, fareKindCode: "IC50" },
        },
        seats: [1, 2, 3].map((number) => ({ number, available: true })),
      });
    }
  }
  const server = createBusServer({ provider: new MixedProvider(), references });
  const client = new Client({ name: "mixed-quote-reference", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  now = 5 * 60_000;
  try {
    // When: the caller refreshes seat fares through MCP.
    const result = await client.callTool({ name: "get_seats", arguments: { tripRef } });
    // Then: the same reference contains the mixed total and still expires at the original deadline.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ tripRef, totalFareKrw: 23000 });
    expect(references.get(tripRef)).toMatchObject({
      totalFareKrw: 23000,
      remainingSeats: 3,
      fareQuotes: { students: { unitFareKrw: 8000, fareKindCode: "IM20" } },
    });
    now = 15 * 60_000;
    expect(references.get(tripRef)).toBeUndefined();
  } finally {
    await client.close();
  }
});
