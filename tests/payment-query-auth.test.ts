import { expect, test } from "bun:test";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import type { AccountStatusService } from "../src/account-tools";
import { AuthenticationRequiredError, type ServiceSource } from "../src/auth-policy";
import { GoAccountError } from "../src/go-account";
import { createHttpHandler } from "../src/http";
import { registerPaymentTools } from "../src/payment-tools";
import { TripReferences } from "../src/trip-references";
import { webTrip } from "./booking-fixtures";
import { syntheticAuthenticate } from "./mcp-auth-fixture";

function paymentServer(account?: ServiceSource<AccountStatusService>) {
  const server = new McpServer({ name: "payment-query", version: "1" });
  registerPaymentTools(server, {
    references: {
      add: () => {
        throw new Error("Service query must not create a trip");
      },
      get: () => {
        throw new Error("Service query must not require a trip");
      },
      updateQuote: () => {
        throw new Error("Service query must not update a trip");
      },
    },
    checkoutEnabled: true,
    purchaseEnabled: true,
    connectionUrl: "https://mcp.example/connect",
    ...(account ? { account } : {}),
  });
  return server;
}

async function accountClient(account?: ServiceSource<AccountStatusService>) {
  const client = new Client({ name: "payment-account-query", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await paymentServer(account).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test.each(["intercity", "express"] as const)(
  "service-only %s inquiry preserves account fields without a trip",
  async (service) => {
    // Given: a current account status and a reference store that forbids trip access.
    const status = {
      connection: "connected",
      naverPay: { registration: "registered", billingReferenceAvailable: true, displayed: true },
      paymentMethods: [
        {
          method: "naver_pay_auto",
          registration: "registered",
          billingReferenceAvailable: true,
          displayed: true,
        },
      ],
    } as const;
    const calls: string[] = [];
    const client = await accountClient({
      getStatus: async (requestedService) => {
        calls.push(requestedService);
        return status;
      },
    });
    try {
      // When: a caller requests account payment status without selecting a trip.
      const result = await client.callTool({ name: "get_payment_options", arguments: { service } });
      // Then: the old account response, including method state and reconnect URL, is retained exactly.
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        service,
        ...status,
        connectionUrl: "https://mcp.example/connect",
      });
      expect(calls).toEqual([service]);
    } finally {
      await client.close();
    }
  },
);

test.each(["not_connected", "not_configured", "absent"] as const)(
  "service-only inquiry retains %s account configuration",
  async (connection) => {
    // Given: an unavailable or unconfigured account source, with no trip access allowed.
    const client = await accountClient(
      connection === "absent" ? undefined : { getStatus: async () => ({ connection }) },
    );
    try {
      // When: the account is inspected by service.
      const result = await client.callTool({
        name: "get_payment_options",
        arguments: { service: "intercity" },
      });
      // Then: not_connected remains distinct from not_configured and the connection link is retained.
      expect(result.structuredContent).toEqual({
        service: "intercity",
        connection: connection === "absent" ? "not_configured" : connection,
        connectionUrl: "https://mcp.example/connect",
      });
    } finally {
      await client.close();
    }
  },
);

test.each(["network", "response", "authentication_required", "resolver"] as const)(
  "service-only inquiry preserves %s errors",
  async (failure) => {
    // Given: a provider error or a caller-bound resolver requiring authentication.
    const client = await accountClient(
      failure === "resolver"
        ? () => {
            throw new AuthenticationRequiredError("https://mcp.example/connect");
          }
        : {
            getStatus: async () => {
              throw new GoAccountError(failure);
            },
          },
    );
    try {
      // When: the account-only branch is called.
      const result = await client.callTool({
        name: "get_payment_options",
        arguments: { service: "express" },
      });
      // Then: errors are not suppressed as they are for public trip payment discovery.
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        {
          type: "text",
          text: JSON.stringify(
            failure === "authentication_required" || failure === "resolver"
              ? { error: "auth_required", connectionUrl: "https://mcp.example/connect" }
              : { error: failure, message: new GoAccountError(failure).message },
          ),
        },
      ]);
    } finally {
      await client.close();
    }
  },
);

test("HTTP payment authorization allows only strict public trip inputs and rejects invalid bearer tokens", async () => {
  // Given: real HTTP dispatch with public trips and an account source that requires authentication.
  const references = new TripReferences();
  const tripRef = references.add(webTrip);
  let accountReads = 0;
  let publicServers = 0;
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler({
      authenticate: syntheticAuthenticate("synthetic-payment-test-token"),
      allowedHosts: ["127.0.0.1"],
      createServer: () => paymentServer(),
      createPublicServer: () => {
        publicServers++;
        const server = new McpServer({ name: "public-payment-query", version: "1" });
        registerPaymentTools(server, {
          references,
          checkoutEnabled: true,
          purchaseEnabled: true,
          account: () => {
            accountReads++;
            throw new AuthenticationRequiredError("https://mcp.example/connect");
          },
        });
        return server;
      },
    }),
  });
  const client = new Client({ name: "public-payment", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", listener.url)));
    // When: an anonymous client requests the valid trip branch.
    const publicResult = await client.callTool({
      name: "get_payment_options",
      arguments: { tripRef },
    });
    // Then: official checkout is available and only the automatic method needs connection.
    expect(publicResult.isError).not.toBe(true);
    expect(publicResult.structuredContent).toMatchObject({
      tripRef,
      options: [{ status: "available" }, { status: "requires_account" }],
    });
    expect(accountReads).toBe(1);
    const publicServersBefore = publicServers;
    const requests = [
      { args: { service: "intercity" } },
      { args: { service: "express" } },
      { args: {} },
      { args: { tripRef, service: "intercity" } },
      { args: { tripRef: "invalid" } },
      { args: { service: "rail" } },
      { args: { tripRef, extra: true } },
      { args: { service: "intercity", token: "synthetic-input" } },
      { args: null },
      { args: undefined },
      { args: { tripRef }, authorization: "Bearer invalid-token" },
    ];
    for (const request of requests) {
      const response = await fetch(new URL("/mcp", listener.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(request.authorization ? { authorization: request.authorization } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "get_payment_options", arguments: request.args },
        }),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="mcp"');
      await response.text();
    }
    expect(publicServers).toBe(publicServersBefore);
    expect(accountReads).toBe(1);
  } finally {
    await client.close();
    await listener.stop(true);
  }
});
