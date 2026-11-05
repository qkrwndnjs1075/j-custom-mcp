import "./public-transport.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { harness, rpc, search, tool } from "./harness.mts";
import { connect } from "./oauth-flow.mts";

test("production Worker exposes MCP and preserves public trip references over workerd restart", async () => {
  const item = await harness();
  try {
    const initialized = await rpc(item, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "workerd-integration", version: "1" },
    });
    assert.equal(initialized.protocolVersion, "2025-03-26");
    const inventory = z
      .object({ tools: z.array(z.object({ name: z.string() })) })
      .parse(await rpc(item, "tools/list", {}));
    assert.ok(inventory.tools.some((entry) => entry.name === "search_trips"));
    const denied = await item.request("/mcp", {
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
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
    const searchResult = await tool(item, "search_trips", search);
    assert.notEqual(searchResult.isError, true, JSON.stringify(searchResult));
    const result = z
      .object({
        structuredContent: z.object({
          trips: z
            .tuple([z.object({ tripRef: z.string() })])
            .rest(z.object({ tripRef: z.string() })),
        }),
      })
      .parse(searchResult);
    const tripRef = result.structuredContent.trips[0].tripRef;
    await item.restart();
    const seats = await tool(item, "get_seats", { tripRef });
    assert.notEqual(seats.isError, true, JSON.stringify(seats));
    const checkout = z
      .object({ structuredContent: z.object({ status: z.string(), checkoutUrl: z.string() }) })
      .parse(
        await tool(item, "prepare_checkout", {
          tripRef,
          maxFareKrw: 30000,
          payment: { method: "official_card" },
        }),
      );
    assert.equal(checkout.structuredContent.status, "requires_user_checkout");
    const page = await item.request(checkout.structuredContent.checkoutUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /action="https:\/\/txbus.t-money.co.kr/);
    assert.deepEqual(item.unexpected, []);
  } finally {
    await item.close();
  }
});

test("OAuth and GO browser connection survive workerd restarts and isolate two account trip stores", async () => {
  const item = await harness();
  try {
    const alice = await connect(item, "01011112222", true);
    const bob = await connect(item, "01033334444");
    await item.restart();
    const requests = await tool(item, "list_requests", {}, alice.access_token);
    assert.deepEqual(requests.structuredContent, {
      watches: [],
      bookings: [],
      delivery: "inbox_only",
    });
    const result = z
      .object({
        structuredContent: z.object({
          trips: z
            .tuple([z.object({ tripRef: z.string() })])
            .rest(z.object({ tripRef: z.string() })),
        }),
      })
      .parse(await tool(item, "search_trips", search, alice.access_token));
    const tripRef = result.structuredContent.trips[0].tripRef;
    await item.restart();
    assert.notEqual((await tool(item, "get_seats", { tripRef }, alice.access_token)).isError, true);
    assert.equal((await tool(item, "get_seats", { tripRef }, bob.access_token)).isError, true);
    assert.equal((await tool(item, "get_seats", { tripRef })).isError, true);
    assert.deepEqual(item.unexpected, []);
  } finally {
    await item.close();
  }
});

test("wrong vault key fails closed and restoring original key recovers existing browser state", async () => {
  const item = await harness();
  try {
    const page = await item.request("/connect");
    assert.equal(page.status, 200);
    const cookie = page.headers.get("set-cookie")?.split(";")[0] ?? "";
    const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
    assert.ok(csrf);
    await item.restart(Buffer.alloc(32, 29).toString("base64"));
    const broken = await item.request("/connect", { headers: { cookie } });
    assert.equal(broken.status, 500);
    await item.restart();
    const recovered = await item.request("/connect", { headers: { cookie } });
    assert.equal(recovered.status, 200);
    assert.equal(/name="csrf" value="([^"]+)"/.exec(await recovered.text())?.[1], csrf);
    assert.deepEqual(item.unexpected, []);
  } finally {
    await item.close();
  }
});

test("persisted watch wakes through a real Durable Object alarm after workerd restart", async () => {
  const item = await harness();
  try {
    const alice = await connect(item, "01011112222");
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const observed = item.nextOutbound();
    const watch = await tool(
      item,
      "watch_trips",
      {
        criteria: {
          ...search,
          date: tomorrow,
          time: "00:00",
          endTime: "23:59",
          maxFareKrw: 30000,
          minSeats: 1,
          ranking: ["departure_time"],
        },
        mode: "seats_available",
        notification: "on_transition",
        retryPolicy: { mode: "fixed_interval" },
        intervalSeconds: 300,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
      alice.access_token,
    );
    assert.notEqual(watch.isError, true, JSON.stringify(watch));
    await item.restart();
    await observed;
    const deadline = Date.now() + 10000;
    let checked: string | null = null;
    while (checked === null && Date.now() < deadline) {
      const state = z
        .object({
          structuredContent: z.object({
            watches: z.array(z.object({ lastCheckedAt: z.string().nullable() })).length(1),
          }),
        })
        .parse(await tool(item, "list_requests", {}, alice.access_token));
      checked = state.structuredContent.watches[0]?.lastCheckedAt ?? null;
    }
    assert.ok(checked, "Alarm must persist its completed observation, not merely fetch upstream");
    assert.deepEqual(item.unexpected, []);
  } finally {
    await item.close();
  }
});

test("production express provider searches terminals, schedules and seats using native workerd fetch", async () => {
  const item = await harness();
  try {
    const terminalResult = await tool(item, "search_terminals", {
      service: "express",
      query: "센트럴",
    });
    assert.notEqual(terminalResult.isError, true, JSON.stringify(terminalResult));
    const terminals = z
      .object({
        structuredContent: z.object({
          terminals: z.array(z.object({ id: z.string(), name: z.string() })),
        }),
      })
      .parse(terminalResult);
    assert.ok(
      terminals.structuredContent.terminals.some(
        (terminal) => terminal.id === "021" && terminal.name === "센트럴시티(서울)",
      ),
    );
    const page = z
      .object({
        structuredContent: z.object({
          trips: z.array(z.object({ tripRef: z.string(), departureTime: z.string() })),
        }),
      })
      .parse(
        await tool(item, "search_trips", {
          service: "express",
          departureId: "021",
          arrivalId: "393",
          date: "2026-10-26",
          time: "14:00",
          passengers: { adults: 1, students: 0, children: 0 },
        }),
      );
    const trip = page.structuredContent.trips.find((entry) => entry.departureTime === "142000");
    assert.ok(trip, "Captured express schedule must expose the 14:20 departure");
    await item.restart();
    const seats = z
      .object({
        structuredContent: z.object({
          service: z.literal("express"),
          adultFareKrw: z.number(),
          totalSeats: z.number(),
        }),
      })
      .parse(await tool(item, "get_seats", { tripRef: trip.tripRef }));
    assert.equal(seats.structuredContent.adultFareKrw, 15100);
    assert.equal(seats.structuredContent.totalSeats, 28);
    assert.deepEqual(
      item.calls.filter((path) => path.startsWith("www.kobus.co.kr")),
      [
        "www.kobus.co.kr/mrs/readRotLinInf.ajax",
        "www.kobus.co.kr/mrs/readRotLinInf.ajax",
        "www.kobus.co.kr/mrs/alcnSrch.do",
        "www.kobus.co.kr/mrs/satschc.do",
      ],
    );
    assert.deepEqual(item.unexpected, []);
  } finally {
    await item.close();
  }
});
