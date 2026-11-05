import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { AuthenticationRequiredError } from "../src/auth-policy";
import { bookingBinding } from "../src/booking-types";
import { registerRequestTools } from "../src/request-tools";
import { WatchRunner } from "../src/watch-runner";
import { WatchStore } from "../src/watch-store";
import { WatchSpecSchema } from "../src/watch-types";
import { credentials, harness, held, specification } from "./booking-fixtures";

function requests() {
  const booking = harness();
  const store = new WatchStore(join(booking.directory, "watches.sqlite"), () => booking.state.now);
  const runner = new WatchRunner({
    store,
    evaluate: async () => ({ kind: "not_matched" }),
  });
  const spec = specification();
  const watch = store.create(
    WatchSpecSchema.parse({
      criteria: spec.criteria,
      mode: "seats_available",
      notification: "on_transition",
      retryPolicy: { mode: "fixed_interval" },
      intervalSeconds: spec.intervalSeconds,
      expiresAt: spec.expiresAt,
    }),
  ).watch;
  store.record(watch.id, { kind: "unknown", reason: "fixture_provider_unavailable" });
  booking.store.create(spec, bookingBinding(credentials));
  const record = booking.store.records()[0];
  if (!record) throw new TypeError("Missing fixture booking");
  const holding = booking.store.transition(record, "holding");
  if (!holding) throw new TypeError("Missing fixture transition");
  booking.store.transition(holding, "uncertain", {
    lastError: "hold_uncertain",
    hold: held,
    paymentOrderNumber: "synthetic-private-order",
  });
  return {
    watches: { store, runner },
    bookings: { store: booking.store, runner: booking.runner },
    actions: booking.actions,
    close() {
      store.close();
      booking.store.close();
      rmSync(booking.directory, { recursive: true, force: true });
    },
  };
}

async function connect(server: McpServer) {
  const client = new Client({ name: "request-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right);
  await client.connect(left);
  return client;
}

test.each(["both", "watches", "bookings"] as const)(
  "list_requests preserves complete records with %s configured",
  async (kind) => {
    // Given
    const item = requests();
    const services = kind === "both" ? item : { [kind]: item[kind] };
    const server = new McpServer({ name: "request-test", version: "1" });
    registerRequestTools(server, services);
    const client = await connect(server);
    try {
      // When
      const result = await client.callTool({ name: "list_requests", arguments: {} });
      // Then
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        watches: kind === "bookings" ? [] : item.watches.store.list(),
        bookings: kind === "watches" ? [] : item.bookings.store.list(),
        delivery: "inbox_only",
      });
    } finally {
      await client.close();
      await server.close();
      item.close();
    }
  },
);

test("list_requests neither advances runners nor exposes financial internals", async () => {
  // Given
  const item = requests();
  const watchTick = spyOn(item.watches.runner, "tick");
  const bookingTick = spyOn(item.bookings.runner, "tick");
  const server = new McpServer({ name: "request-test", version: "1" });
  registerRequestTools(server, item);
  const client = await connect(server);
  try {
    // When
    const result = await client.callTool({ name: "list_requests", arguments: {} });
    // Then
    expect(result.structuredContent).toMatchObject({
      watches: [{ lastOutcome: "unknown", lastError: "fixture_provider_unavailable" }],
      bookings: [{ stage: "uncertain", lastError: "hold_uncertain" }],
    });
    const serialized = JSON.stringify(result);
    for (const value of ["synthetic-hold-private", "synthetic-private-order", "bindingHash"])
      expect(serialized).not.toContain(value);
    expect(watchTick).not.toHaveBeenCalled();
    expect(bookingTick).not.toHaveBeenCalled();
    expect(item.actions).toEqual([]);
  } finally {
    watchTick.mockRestore();
    bookingTick.mockRestore();
    await client.close();
    await server.close();
    item.close();
  }
});

test("list_requests resolves the current caller for each invocation", async () => {
  // Given
  const first = requests();
  const second = requests();
  let current = first;
  const server = new McpServer({ name: "request-test", version: "1" });
  registerRequestTools(server, {
    watches: () => current.watches,
    bookings: () => current.bookings,
  });
  const client = await connect(server);
  try {
    for (const caller of [first, second]) {
      current = caller;
      // When
      const result = await client.callTool({ name: "list_requests", arguments: {} });
      // Then
      expect(result.structuredContent).toEqual({
        watches: caller.watches.store.list(),
        bookings: caller.bookings.store.list(),
        delivery: "inbox_only",
      });
    }
  } finally {
    await client.close();
    await server.close();
    first.close();
    second.close();
  }
});

test.each(["watches", "bookings"] as const)(
  "list_requests preserves authentication errors from configured %s",
  async (kind) => {
    // Given
    const server = new McpServer({ name: "request-test", version: "1" });
    const connectionUrl = "https://example.test/connect";
    registerRequestTools(server, {
      [kind]: () => {
        throw new AuthenticationRequiredError(connectionUrl);
      },
    });
    const client = await connect(server);
    try {
      // When
      const result = await client.callTool({ name: "list_requests", arguments: {} });
      // Then
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result.content).toEqual([
        { type: "text", text: JSON.stringify({ error: "auth_required", connectionUrl }) },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  },
);

test("list_requests rejects caller-selected ownership before resolving services", async () => {
  // Given
  const server = new McpServer({ name: "request-test", version: "1" });
  let resolutions = 0;
  registerRequestTools(server, {
    watches: () => {
      resolutions++;
      throw new AuthenticationRequiredError("https://example.test/connect");
    },
  });
  const client = await connect(server);
  try {
    // When
    const result = await client.callTool({
      name: "list_requests",
      arguments: { userId: crypto.randomUUID() },
    });
    // Then
    expect(result.isError).toBe(true);
    expect(resolutions).toBe(0);
    const tools = await client.listTools();
    expect(tools.tools).toMatchObject([
      {
        name: "list_requests",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});
