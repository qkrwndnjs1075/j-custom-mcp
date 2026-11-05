import { expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { AccountStatusService } from "../src/account-tools";
import { AuthenticationRequiredError, type ServiceSource } from "../src/auth-policy";
import { GoAccountError, type GoPaymentMethodStatus } from "../src/go-account";
import { TmoneyIntercityClient } from "../src/provider";
import { createBusServer } from "../src/tools";
import { TripReferences } from "../src/trip-references";
import { webTrip } from "./booking-fixtures";

async function fixture(account: ServiceSource<AccountStatusService>) {
  const references = new TripReferences();
  const tripRef = references.add(webTrip);
  let seatsRead = 0;
  class Guard extends TmoneyIntercityClient {
    override async getSeats(): Promise<never> {
      seatsRead++;
      throw new Error("Payment options must not reserve or read seats");
    }
  }
  const server = createBusServer({
    provider: new Guard(),
    references,
    account,
    bookings: () => {
      throw new Error("Payment inquiry must not execute a booking");
    },
    checkoutBaseUrl: new URL("https://mcp.example"),
    connectionUrl: "https://mcp.example/connect",
  });
  const client = new Client({ name: "payment-options", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, tripRef, seatsRead: () => seatsRead };
}

const registered = (method: GoPaymentMethodStatus["method"]): GoPaymentMethodStatus => ({
  method,
  registration: "registered",
  billingReferenceAvailable: true,
  displayed: true,
});
const connected = (paymentMethods: readonly GoPaymentMethodStatus[]): AccountStatusService => ({
  getStatus: async () => ({
    connection: "connected",
    naverPay: { registration: "unknown", billingReferenceAvailable: null, displayed: null },
    paymentMethods,
  }),
});

test("anonymous payment discovery offers official card and requests connection only for automatic payment", async () => {
  // Given: a public trip reference and an account service that requires connection.
  const { client, tripRef, seatsRead } = await fixture(() => {
    throw new AuthenticationRequiredError("https://mcp.example/connect");
  });
  try {
    // When: the client asks for actual payment paths without logging in.
    const result = await client.callTool({ name: "get_payment_options", arguments: { tripRef } });
    // Then: card checkout remains usable, automatic payment requires an account, and no seats are touched.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      options: [
        {
          payment: { method: "official_card" },
          status: "available",
          executionMode: "user_checkout",
          requiresGoAccount: false,
        },
        {
          payment: { method: "naver_pay_auto" },
          status: "requires_account",
          executionMode: "automatic",
        },
      ],
      registeredMethods: [],
      account: { connection: "requires_account" },
    });
    expect(seatsRead()).toBe(0);
  } finally {
    await client.close();
  }
});

test.each([
  { method: registered("naver_pay_auto"), status: "available" },
  { method: { ...registered("naver_pay_auto"), displayed: false }, status: "unavailable" },
  {
    method: { ...registered("naver_pay_auto"), registration: "not_registered" as const },
    status: "not_registered",
  },
  {
    method: { ...registered("naver_pay_auto"), billingReferenceAvailable: false },
    status: "unavailable",
  },
])(
  "payment discovery respects the automatic method's own current status: $status",
  async ({ method, status }) => {
    // Given: GO returns a method-specific status, including other registered payment methods.
    const { client, tripRef } = await fixture(
      connected([method, registered("registered_card"), registered("toss_pay_auto")]),
    );
    try {
      // When: the client asks which execution paths this server supports.
      const result = await client.callTool({ name: "get_payment_options", arguments: { tripRef } });
      // Then: only the implemented automatic adapter is executable; registration does not invent an adapter.
      expect(result.structuredContent).toMatchObject({
        options: [
          { payment: { method: "official_card" } },
          { payment: { method: "naver_pay_auto" }, status },
        ],
        registeredMethods: [
          { method: "naver_pay_auto", executionSupported: true },
          { method: "registered_card", executionSupported: false },
          { method: "toss_pay_auto", executionSupported: false },
        ],
      });
    } finally {
      await client.close();
    }
  },
);

test.each([
  { error: "network" as const, connection: "unknown" },
  { error: "response" as const, connection: "unknown" },
  { error: "authentication_required" as const, connection: "requires_account" },
])("GO inquiry failure preserves the official card path: $error", async ({ error, connection }) => {
  // Given: the remote account inquiry fails before payment selection.
  const { client, tripRef } = await fixture({
    getStatus: async () => {
      throw new GoAccountError(error);
    },
  });
  try {
    // When: payment paths are requested.
    const result = await client.callTool({ name: "get_payment_options", arguments: { tripRef } });
    // Then: the failure is explicit and cannot be mistaken for no registered payment methods.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      options: [{ status: "available" }, { status: connection }],
      account: { connection },
    });
  } finally {
    await client.close();
  }
});

test("unknown trip and unsupported checkout payment fail before any provider inquiry", async () => {
  // Given: provider/account methods that record any unintended access.
  let accountReads = 0;
  const { client, tripRef, seatsRead } = await fixture({
    getStatus: async () => {
      accountReads++;
      return { connection: "not_connected" };
    },
  });
  try {
    // When: callers use an invented trip or omit/substitute the explicitly selected payment method.
    const absent = await client.callTool({
      name: "get_payment_options",
      arguments: { tripRef: crypto.randomUUID() },
    });
    expect(absent.isError).toBe(true);
    for (const payment of [
      undefined,
      { method: "naver_pay_auto" },
      { method: "registered_card" },
    ]) {
      const result = await client.callTool({
        name: "prepare_checkout",
        arguments: { tripRef, maxFareKrw: 20000, ...(payment ? { payment } : {}) },
      });
      expect(result.isError).toBe(true);
    }
    // Then: no fallback payment path is chosen and no provider operation occurs.
    expect(accountReads).toBe(0);
    expect(seatsRead()).toBe(0);
  } finally {
    await client.close();
  }
});

test("payment inquiry rejects mixed, missing, malformed and extra arguments before provider access", async () => {
  // Given: account and seat providers record unexpected reads.
  let accountReads = 0;
  const { client, tripRef, seatsRead } = await fixture({
    getStatus: async () => {
      accountReads++;
      return { connection: "not_connected" };
    },
  });
  try {
    // When: either exclusive input contract is violated.
    for (const input of [
      {},
      { tripRef, service: "intercity" },
      { tripRef: "invalid" },
      { service: "rail" },
      { tripRef, extra: true },
      { service: "express", token: "synthetic-tool-input" },
      { tripRef: null },
      { service: null },
    ]) {
      const result = await client.callTool({ name: "get_payment_options", arguments: input });
      // Then: validation fails without leaking supplied credentials or accessing providers.
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("synthetic-tool-input");
    }
    expect(accountReads).toBe(0);
    expect(seatsRead()).toBe(0);
  } finally {
    await client.close();
  }
});
