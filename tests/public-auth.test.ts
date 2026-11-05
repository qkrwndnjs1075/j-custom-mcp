import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { AppConfigSchema } from "../src/app-config";
import { createApplication } from "../src/application";
import { AuthenticationRequiredError } from "../src/auth-policy";
import { GoAccountError } from "../src/go-account";
import { TmoneyIntercityClient } from "../src/provider";
import { createBusServer } from "../src/tools";
import { TripReferences, withPublicReferences } from "../src/trip-references";
import { webTrip } from "./booking-fixtures";
import { publicProviderFixture } from "./public-provider-fixture";

test("anonymous HTTP client searches seats and opens checkout without creating tenant storage", async () => {
  // Given a real application and a provider wire fixture, with every other external request blocked.
  const directory = mkdtempSync(join(tmpdir(), "anonymous-http-"));
  const publicResponse = await publicProviderFixture();
  const outbound: string[] = [];
  const networkFetch = globalThis.fetch;
  const interception = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.hostname === "127.0.0.1") return networkFetch(input, init);
        if (url.hostname !== "txbus.t-money.co.kr")
          throw new TypeError("Unexpected external request");
        outbound.push(url.pathname);
        const response = publicResponse(url);
        if (!response) throw new TypeError("Unexpected provider request");
        return response;
      },
      { preconnect: networkFetch.preconnect },
    ),
  );
  const app = await createApplication(
    AppConfigSchema.parse({
      DATA_DIRECTORY: directory,
      MCP_BASE_URL: "https://mcp.example",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
    }),
  );
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const client = new Client({ name: "anonymous", version: "1" });
  try {
    // When an anonymous MCP client completes the read-only trip-to-checkout flow.
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", listener.url)));
    const inventory = await client.listTools();
    const terminals = await client.callTool({
      name: "search_terminals",
      arguments: { service: "intercity", query: "Departure" },
    });
    const trips = await client.callTool({
      name: "search_trips",
      arguments: {
        service: "intercity",
        departureId: "0671801",
        arrivalId: "3455101",
        date: "2026-10-21",
        time: "11:00",
        passengers: { adults: 1, students: 0, children: 0 },
      },
    });
    const ref = z
      .object({
        trips: z.tuple([z.object({ tripRef: z.string() })]).rest(z.object({ tripRef: z.string() })),
      })
      .parse(trips.structuredContent).trips[0].tripRef;
    const seatResult = await client.callTool({ name: "get_seats", arguments: { tripRef: ref } });
    const payment = await client.callTool({
      name: "get_payment_options",
      arguments: { tripRef: ref },
    });
    expect(payment.isError).not.toBe(true);
    expect(payment.structuredContent).toMatchObject({
      account: { connection: "requires_account" },
    });
    const checkout = await client.callTool({
      name: "prepare_checkout",
      arguments: { tripRef: ref, maxFareKrw: 20000, payment: { method: "official_card" } },
    });
    const checkoutUrl = z
      .object({ checkoutUrl: z.string() })
      .parse(checkout.structuredContent).checkoutUrl;
    const page = await networkFetch(new URL(new URL(checkoutUrl).pathname, listener.url));
    // Then real provider parsing and the public capability URL work without personal stores.
    expect(inventory.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "get_payment_options",
        "watch_trips",
        "book_trip",
        "list_requests",
        "list_tickets",
        "get_cancellation_quote",
        "cancel_ticket",
      ]),
    );
    expect(terminals.isError).not.toBe(true);
    expect(seatResult.structuredContent).toMatchObject({ availableSeats: 1, adultFareKrw: 17200 });
    expect(checkout.structuredContent).toMatchObject({
      status: "requires_user_checkout",
      totalFareKrw: 17200,
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("https://txbus.t-money.co.kr");
    expect(outbound.filter((path) => path === "/otck/readSatsFee.do")).toHaveLength(2);
    expect(existsSync(join(directory, "users"))).toBe(false);
  } finally {
    await client.close();
    listener.stop(true);
    await app.close();
    interception.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("protected tools fail closed when invoked without HTTP authentication", async () => {
  // Given an anonymous server with resolvers that require a real connection.
  const requireConnection = (): never => {
    throw new AuthenticationRequiredError("https://mcp.example/connect");
  };
  const server = createBusServer({
    provider: new TmoneyIntercityClient(),
    references: new TripReferences(),
    account: requireConnection,
    watches: requireConnection,
    bookings: requireConnection,
    cancellations: requireConnection,
  });
  const client = new Client({ name: "anonymous-direct", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    // When private listing tools are invoked directly.
    const calls = [
      { name: "get_payment_options", arguments: { service: "intercity" } },
      { name: "list_requests", arguments: {} },
      { name: "list_tickets", arguments: { service: "intercity" } },
      {
        name: "get_cancellation_quote",
        arguments: { ticketRef: crypto.randomUUID(), selection: { mode: "all" } },
      },
      {
        name: "cancel_ticket",
        arguments: {
          quoteRef: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID(),
          acceptedFeeKrw: 0,
        },
      },
    ];
    for (const call of calls) {
      const result = await client.callTool({
        ...call,
      });
      // Then no protected service is created and an actionable safe error is returned.
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            error: "auth_required",
            connectionUrl: "https://mcp.example/connect",
          }),
        },
      ]);
    }
  } finally {
    await client.close();
  }
});

test("updating a shared reference preserves its original expiry and capacity", () => {
  // Given a bounded public reference store shared with one authenticated view.
  let now = 0;
  const shared = new TripReferences(() => now, { tripReferences: 1, tripReferenceTtlSeconds: 10 });
  const view = withPublicReferences(new TripReferences(() => now), shared);
  const old = shared.add(webTrip);
  const reference = shared.add(webTrip);
  now = 9000;
  // When an authenticated caller refreshes its public quote.
  expect(view.updateQuote(reference, { ...webTrip, adultFareKrw: 22000 })).toBe(true);
  // Then the original public lifetime and eviction policy remain intact.
  expect(shared.get(old)).toBeUndefined();
  expect(shared.get(reference)?.adultFareKrw).toBe(22000);
  now = 10000;
  expect(view.get(reference)).toBeUndefined();
});

test("expired GO session returns a reconnect signal without retrying account inquiry", async () => {
  // Given a linked account whose GO session has expired.
  let attempts = 0;
  const server = createBusServer({
    provider: new TmoneyIntercityClient(),
    references: new TripReferences(),
    connectionUrl: "https://mcp.example/connect",
    account: {
      getStatus: async () => {
        attempts++;
        throw new GoAccountError("authentication_required");
      },
    },
  });
  const client = new Client({ name: "expired-session", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    // When the user asks for account status.
    const result = await client.callTool({
      name: "get_payment_options",
      arguments: { service: "intercity" },
    });
    // Then the response links to reconnection and does not retry the provider.
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({
          error: "auth_required",
          connectionUrl: "https://mcp.example/connect",
        }),
      },
    ]);
    expect(attempts).toBe(1);
  } finally {
    await client.close();
  }
});
