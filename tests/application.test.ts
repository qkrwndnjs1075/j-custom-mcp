import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Client,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { AppConfigSchema } from "../src/app-config";
import { createApplication } from "../src/application";
import { AuthTokenStore } from "../src/auth-token-store";
import { BookingSpecSchema } from "../src/booking-types";
import { oauthSecret } from "../src/oauth-types";
import { UserStore } from "../src/user-store";
import { credentials } from "./booking-fixtures";
import { oauthGrantFixture } from "./oauth-grant-fixture";
import { publicProviderFixture } from "./public-provider-fixture";

test.each(["/mcp", "/mcp/account"])(
  "real application authenticates durable OAuth grants and isolates user tools at %s",
  async (privatePath) => {
    const directory = mkdtempSync(join(tmpdir(), "application-http-"));
    const users = new UserStore(join(directory, "accounts.sqlite"));
    const tokens = new AuthTokenStore(join(directory, "oauth.sqlite"));
    const a = users.connect({ ...credentials, token: "synthetic-alice-access" });
    const b = users.connect({
      ...credentials,
      moappMbrsSno: "synthetic-bob",
      token: "synthetic-bob-access",
    });
    const grant = oauthGrantFixture(tokens, `https://mcp.example${privatePath}`);
    const aliceToken = grant(a.userId);
    const bobToken = grant(b.userId);
    const wrongAudience = oauthGrantFixture(
      tokens,
      `https://mcp.example${privatePath === "/mcp" ? "/mcp/account" : "/mcp"}`,
    )(a.userId);
    const publicResponse = await publicProviderFixture();
    const outboundHeaders: (string | null)[] = [];
    const networkFetch = globalThis.fetch;
    const interception = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          if (url.hostname === "127.0.0.1") return networkFetch(input, init);
          const providerResponse = publicResponse(url);
          if (providerResponse) return providerResponse;
          if (
            url.hostname === "tiaapi.tmoney.co.kr" &&
            url.pathname.endsWith("/inqrPymMnsListAtPym")
          ) {
            const request = input instanceof Request ? input : new Request(input, init);
            outboundHeaders.push(request.headers.get("Authorization"));
            return Response.json({
              rstCd: 200,
              dta: { npayautPymInfo: null, npayPymInfo: { displayYn: "Y" } },
            });
          }
          throw new TypeError("Unexpected external request in application QA");
        },
        { preconnect: networkFetch.preconnect },
      ),
    );
    const app = await createApplication(
      AppConfigSchema.parse({
        DATA_DIRECTORY: directory,
        MCP_BASE_URL: "https://mcp.example",
        MCP_ALLOWED_HOSTS: "127.0.0.1",
        MCP_LIMITS: JSON.stringify({
          activeBookings: 1,
          retainedBookings: 2,
          minimumPollSeconds: 1,
        }),
      }),
    );
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    const anonymous = new Client({ name: "anonymous-test", version: "1" });
    const alice = new Client({ name: "alice-application-test", version: "1" });
    const bob = new Client({ name: "bob-application-test", version: "1" });
    try {
      expect((await networkFetch(new URL("/health", listener.url))).status).toBe(200);
      const crossed = await networkFetch(new URL(privatePath, listener.url), {
        method: "POST",
        headers: {
          authorization: `Bearer ${wrongAudience.access_token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
      });
      expect(crossed.status).toBe(401);
      expect(crossed.headers.get("www-authenticate")).toContain(
        `resource_metadata="https://mcp.example/.well-known/oauth-protected-resource${privatePath}"`,
      );
      const unauthorized = await networkFetch(new URL("/mcp", listener.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_requests", arguments: {} },
        }),
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("www-authenticate")).toContain("oauth-protected-resource");
      for (const name of ["list_tickets", "get_cancellation_quote", "cancel_ticket"]) {
        const denied = await networkFetch(new URL("/mcp", listener.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: { name, arguments: {} },
          }),
        });
        expect(denied.status).toBe(401);
        expect(denied.headers.get("www-authenticate")).toContain("oauth-protected-resource");
      }
      for (const args of [
        { service: "intercity" },
        { service: "express" },
        {},
        { service: "intercity", tripRef: crypto.randomUUID() },
        { tripRef: crypto.randomUUID(), token: "synthetic-forged" },
      ]) {
        const denied = await networkFetch(new URL("/mcp", listener.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "get_payment_options", arguments: args },
          }),
        });
        expect(denied.status).toBe(401);
        expect(denied.headers.get("www-authenticate")).toContain("oauth-protected-resource");
      }
      expect(outboundHeaders).toHaveLength(0);
      await anonymous.connect(new StreamableHTTPClientTransport(new URL("/mcp", listener.url)));
      const publicInventory = await anonymous.listTools();
      expect(publicInventory.tools).toHaveLength(17);
      const names = publicInventory.tools.map((tool) => tool.name);
      expect(new Set(names).size).toBe(17);
      for (const removed of ["get_account_status", "list_watches", "list_booking_requests"])
        expect(names).not.toContain(removed);
      expect(names).toContain("list_requests");
      const search = {
        service: "intercity",
        departureId: "0671801",
        arrivalId: "3455101",
        date: "2026-10-21",
        time: "11:00",
        passengers: { adults: 1, students: 0, children: 0 },
      };
      const refs = z.object({
        trips: z.tuple([z.object({ tripRef: z.string() })]).rest(z.object({ tripRef: z.string() })),
      });
      const publicSearch = await anonymous.callTool({ name: "search_trips", arguments: search });
      const publicRef = refs.parse(publicSearch.structuredContent).trips[0].tripRef;
      const publicPayment = await anonymous.callTool({
        name: "get_payment_options",
        arguments: { tripRef: publicRef },
      });
      expect(publicPayment.isError).not.toBe(true);
      expect(publicPayment.structuredContent).toMatchObject({
        account: { connection: "requires_account" },
        options: expect.arrayContaining([
          {
            payment: { method: "official_card" },
            label: "공식 사이트 카드 결제",
            status: "available",
            executionMode: "user_checkout",
            requiresGoAccount: false,
            tool: "prepare_checkout",
          },
        ]),
      });
      expect(outboundHeaders).toHaveLength(0);
      const invalidBearer = await networkFetch(new URL("/mcp", listener.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer invalid",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "get_payment_options", arguments: { tripRef: publicRef } },
        }),
      });
      expect(invalidBearer.status).toBe(401);
      for (const [client, token, forgedUser] of [
        [alice, aliceToken.access_token, b.userId],
        [bob, bobToken.access_token, a.userId],
      ] as const) {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(privatePath, listener.url), {
            requestInit: { headers: { Authorization: `Bearer ${token}`, "x-user-id": forgedUser } },
          }),
        );
        expect((await client.listTools()).tools).toEqual(publicInventory.tools);
        expect(
          (await client.callTool({ name: "get_seats", arguments: { tripRef: publicRef } }))
            .structuredContent,
        ).toMatchObject({ adultFareKrw: 17200 });
        const status = await client.callTool({
          name: "get_payment_options",
          arguments: { service: "intercity" },
        });
        expect(status.isError).not.toBe(true);
        expect(status.structuredContent).toMatchObject({ connection: "connected" });
      }
      for (const name of ["get_account_status", "list_watches", "list_booking_requests"]) {
        await expect(alice.callTool({ name, arguments: { service: "intercity" } })).rejects.toThrow(
          "not found",
        );
      }
      const privateSearch = await alice.callTool({ name: "search_trips", arguments: search });
      const privateRef = refs.parse(privateSearch.structuredContent).trips[0].tripRef;
      expect(
        (await bob.callTool({ name: "get_seats", arguments: { tripRef: privateRef } })).isError,
      ).toBe(true);
      expect(
        (await anonymous.callTool({ name: "get_seats", arguments: { tripRef: privateRef } }))
          .isError,
      ).toBe(true);
      expect(outboundHeaders).toEqual([
        "Bearer synthetic-alice-access",
        "Bearer synthetic-bob-access",
      ]);
      const capabilities = await alice.callTool({
        name: "get_service_capabilities",
        arguments: {},
      });
      expect(capabilities.structuredContent).toMatchObject({
        limits: { activeBookings: 1, retainedBookings: 2, minimumPollSeconds: 1 },
        booking: { directTool: "book_trip", paymentMethods: ["naver_pay_auto"] },
        authentication: {
          configured: false,
          methods: [],
          publicToolConditions: { get_payment_options: "tripRef_only" },
        },
        ticketCancellation: {
          services: ["intercity", "express"],
          paymentMethods: ["naver_pay_auto"],
          selectionModes: ["all", "seats"],
          feeConsent: "preflight_only",
          atomicMaximumFee: false,
          bankSettlementConfirmed: false,
        },
      });
      const date = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      const spec = BookingSpecSchema.parse({
        version: 2,
        idempotencyKey: crypto.randomUUID(),
        criteria: {
          service: "intercity",
          departureId: "0000001",
          arrivalId: "0000002",
          date,
          maxFareKrw: 20000,
          time: "08:00",
          endTime: "12:00",
          minSeats: 1,
          passengers: { adults: 1, students: 0, children: 0 },
          ranking: ["fare"],
        },
        expiresAt: `${date}T08:00:00+09:00`,
        intervalSeconds: 10,
        seatPolicy: { mode: "only", seats: [{ seat: 7, passengerType: "adult" }] },
        payment: { method: "naver_pay_auto" },
        discounts: { mode: "none" },
      });
      const created = await alice.callTool({ name: "create_booking_request", arguments: spec });
      expect(created.isError).not.toBe(true);
      const overCapacity = await alice.callTool({
        name: "create_booking_request",
        arguments: { ...spec, idempotencyKey: crypto.randomUUID() },
      });
      expect(overCapacity.isError).toBe(true);
      const booking = z
        .object({ booking: z.object({ id: z.string() }) })
        .parse(created.structuredContent).booking;
      expect(
        (await bob.callTool({ name: "list_requests", arguments: {} })).structuredContent,
      ).toEqual({ bookings: [], watches: [], delivery: "inbox_only" });
      expect(
        (
          await bob.callTool({
            name: "cancel_booking_request",
            arguments: { bookingId: booking.id },
          })
        ).structuredContent,
      ).toMatchObject({ cancelled: false });
      const aliceList = await alice.callTool({ name: "list_requests", arguments: {} });
      expect(aliceList.structuredContent).toMatchObject({
        bookings: [{ id: booking.id, stage: "watching" }],
      });
      expect(
        (
          await alice.callTool({
            name: "cancel_booking_request",
            arguments: { bookingId: booking.id },
          })
        ).structuredContent,
      ).toMatchObject({ cancelled: true });
      const watch = await alice.callTool({
        name: "watch_trips",
        arguments: {
          mode: "seats_available",
          criteria: spec.criteria,
          expiresAt: spec.expiresAt,
          intervalSeconds: 10,
          notification: "on_transition",
          retryPolicy: { mode: "fixed_interval" },
        },
      });
      expect(watch.isError).not.toBe(true);
      const watchId = z
        .object({ watch: z.object({ id: z.string() }) })
        .parse(watch.structuredContent).watch.id;
      expect(
        (await bob.callTool({ name: "list_requests", arguments: {} })).structuredContent,
      ).toMatchObject({ watches: [] });
      expect(
        (await bob.callTool({ name: "cancel_watch", arguments: { watchId } })).structuredContent,
      ).toMatchObject({ cancelled: false });
      expect(
        (await alice.callTool({ name: "list_requests", arguments: {} })).structuredContent,
      ).toMatchObject({
        watches: [{ id: watchId, status: "active" }],
        bookings: [{ id: booking.id, stage: "cancelled" }],
        delivery: "inbox_only",
      });
      expect(
        (await alice.callTool({ name: "cancel_watch", arguments: { watchId } })).structuredContent,
      ).toMatchObject({ cancelled: true });
      users.disconnect(a.userId);
      const disconnected = await networkFetch(new URL(privatePath, listener.url), {
        headers: { Authorization: `Bearer ${aliceToken.access_token}` },
      });
      expect(disconnected.status).toBe(401);
      expect(disconnected.headers.get("www-authenticate")).toContain(
        `resource_metadata="https://mcp.example/.well-known/oauth-protected-resource${privatePath}"`,
      );
      expect((await bob.callTool({ name: "list_requests", arguments: {} })).isError).not.toBe(true);
      expect(outboundHeaders).toHaveLength(2);
    } finally {
      await anonymous.close();
      await alice.close();
      await bob.close();
      listener.stop(true);
      await app.close();
      interception.mockRestore();
      tokens.close();
      users.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("account entry challenges all discovery while original public entry remains usable", async () => {
  // Given
  const directory = mkdtempSync(join(tmpdir(), "account-entry-"));
  const app = await createApplication(
    AppConfigSchema.parse({
      DATA_DIRECTORY: directory,
      MCP_BASE_URL: "https://mcp.example",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
    }),
  );
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  try {
    // When / Then
    const envelopes = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "entry-test", version: "1" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_service_capabilities", arguments: {} },
      },
    ];
    for (const body of envelopes) {
      for (const path of ["/mcp", "/mcp?legacy=1", "/mcp/account"]) {
        const response = await fetch(new URL(path, listener.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(path === "/mcp/account" ? 401 : 200);
        if (path === "/mcp/account")
          expect(response.headers.get("www-authenticate")).toContain(
            'resource_metadata="https://mcp.example/.well-known/oauth-protected-resource/mcp/account"',
          );
        await response.text();
      }
    }
    for (const path of ["/mcp", "/mcp/account"]) {
      const invalid = await fetch(new URL(path, listener.url), {
        method: "POST",
        headers: {
          authorization: "Bearer invalid",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(envelopes[1]),
      });
      expect(invalid.status).toBe(401);
    }
    for (const path of ["/mcp/account/", "/mcp/account/unknown", "/mcp/account?alias=1"]) {
      expect((await fetch(new URL(path, listener.url))).status).toBe(404);
    }
  } finally {
    listener.stop(true);
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SDK discovers account OAuth and dynamically registers before any user grant", async () => {
  // Given
  const directory = mkdtempSync(join(tmpdir(), "account-sdk-discovery-"));
  const app = await createApplication(
    AppConfigSchema.parse({
      DATA_DIRECTORY: directory,
      MCP_BASE_URL: "https://mcp.example",
      MCP_ALLOWED_HOSTS: "127.0.0.1",
    }),
  );
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  const tokens = new AuthTokenStore(join(directory, "oauth.sqlite"));
  const paths: string[] = [];
  const localFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== "https://mcp.example")
      throw new TypeError("Unexpected SDK discovery origin");
    paths.push(url.pathname);
    return fetch(new Request(new URL(`${url.pathname}${url.search}`, listener.url), request), {
      redirect: "manual",
    });
  };
  let information: StoredOAuthClientInformation | undefined;
  let authorizationUrl: URL | undefined;
  let verifier = "";
  const provider: OAuthClientProvider = {
    redirectUrl: "https://client.example/callback",
    clientMetadata: {
      client_name: "SDK discovery fixture",
      redirect_uris: ["https://client.example/callback"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    clientInformation: () => information,
    saveClientInformation: (value) => {
      information = value;
    },
    tokens: () => undefined,
    saveTokens: () => {
      throw new TypeError("Unexpected token issuance before user approval");
    },
    redirectToAuthorization: (url) => {
      authorizationUrl = url;
    },
    saveCodeVerifier: (value) => {
      verifier = value;
    },
    codeVerifier: () => verifier,
  };
  const client = new Client({ name: "sdk-discovery", version: "1" });
  try {
    // When
    await expect(
      client.connect(
        new StreamableHTTPClientTransport(new URL("https://mcp.example/mcp/account"), {
          authProvider: provider,
          fetch: localFetch,
        }),
      ),
    ).rejects.toThrow();
    // Then
    expect(paths).toContain("/mcp/account");
    expect(paths).toContain("/.well-known/oauth-protected-resource/mcp/account");
    expect(paths).toContain("/.well-known/oauth-authorization-server");
    expect(paths).toContain("/oauth/register");
    expect(paths).not.toContain("/oauth/token");
    expect(information).toMatchObject({ client_id: expect.any(String) });
    if (!authorizationUrl) throw new TypeError("SDK did not start authorization");
    expect(authorizationUrl.origin).toBe("https://mcp.example");
    expect(authorizationUrl.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl.searchParams.get("resource")).toBe("https://mcp.example/mcp/account");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const response = await localFetch(authorizationUrl);
    expect(response.status).toBe(302);
    const pending = new URL(response.headers.get("location") ?? "").searchParams.get(
      "authorization",
    );
    if (!pending) throw new TypeError("Missing pending authorization");
    expect(
      tokens.requests.claim(pending, oauthSecret(), Math.floor(Date.now() / 1000)).resource,
    ).toBe("https://mcp.example/mcp/account");
  } finally {
    await client.close();
    listener.stop(true);
    tokens.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
