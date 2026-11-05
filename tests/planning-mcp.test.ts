import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { createHttpHandler } from "../src/http";
import { TmoneyIntercityClient, type TripPage } from "../src/provider";
import { parseTrips } from "../src/provider-html";
import { TripQueryService } from "../src/query";
import { createBusServer } from "../src/tools";
import { TripReferences } from "../src/trip-references";
import { evaluateWatch } from "../src/watch-evaluator";
import { WatchRunner } from "../src/watch-runner";
import { WatchStore } from "../src/watch-store";
import { syntheticAuthenticate } from "./mcp-auth-fixture";

const trips = parseTrips(await Bun.file(new URL("fixtures/dispatch.html", import.meta.url)).text());
class FixtureProvider extends TmoneyIntercityClient {
  override async searchTripPage(): Promise<TripPage> {
    return { trips, unavailable: [], continuation: null, coverage: "end", emptyStatus: "none" };
  }
}

test("HTTP MCP composes planning and persistent watch lifecycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "bus-mcp-"));
  const path = join(directory, "watches.sqlite");
  const store = new WatchStore(path, () => Date.parse("2026-10-20T00:00:00Z"));
  const provider = new FixtureProvider();
  const query = new TripQueryService(provider);
  const runner = new WatchRunner({
    store,
    evaluate: (criteria, mode) => evaluateWatch(query, criteria, mode),
  });
  const references = new TripReferences();
  const token = "test-token-with-at-least-32-characters";
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler({
      authenticate: syntheticAuthenticate(token),
      allowedHosts: ["127.0.0.1"],
      createServer: () =>
        createBusServer({ provider, query, references, watches: { store, runner } }),
    }),
  });
  const client = new Client({ name: "planning-test", version: "1.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", listener.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "cancel_watch",
      "check_alerts",
      "find_journeys",
      "get_payment_options",
      "get_seats",
      "get_service_capabilities",
      "list_requests",
      "search_terminals",
      "search_trips",
      "watch_trips",
    ]);
    const criteria = {
      service: "intercity",
      departureId: "3455101",
      arrivalId: "3198101",
      date: "2026-10-23",
      time: "00:00",
      endTime: "23:59",
      minSeats: 1,
      passengers: { adults: 1, students: 0, children: 0 },
      ranking: ["fare"],
    };
    const planned = await client.callTool({
      name: "find_journeys",
      arguments: { legs: [criteria], maxResults: 10, ranking: ["total_fare"] },
    });
    expect(planned.isError).not.toBe(true);
    const plan = z
      .object({ journeys: z.array(z.object({ legs: z.array(z.object({ tripRef: z.uuid() })) })) })
      .parse(planned.structuredContent);
    expect(plan.journeys.length).toBeGreaterThan(0);
    expect(plan.journeys[0]?.legs[0]?.tripRef).toBeDefined();
    const created = await client.callTool({
      name: "watch_trips",
      arguments: {
        criteria,
        mode: "booking_available",
        intervalSeconds: 300,
        notification: "on_transition",
        retryPolicy: { mode: "fixed_interval" },
        expiresAt: "2026-10-23T23:00:00+09:00",
      },
    });
    expect(created.isError).not.toBe(true);
    const { watch } = z
      .object({ watch: z.object({ id: z.uuid() }) })
      .parse(created.structuredContent);
    const alerts = await client.callTool({
      name: "check_alerts",
      arguments: { after: 0, limit: 50 },
    });
    expect(alerts.structuredContent).toMatchObject({
      delivery: "inbox_only",
      alerts: [{ watchId: watch.id }],
    });
    const page = z.object({ nextCursor: z.number() }).parse(alerts.structuredContent);
    const repeated = await client.callTool({
      name: "check_alerts",
      arguments: { after: page.nextCursor, limit: 50 },
    });
    expect(repeated.structuredContent).toMatchObject({ alerts: [] });
    const cancelled = await client.callTool({
      name: "cancel_watch",
      arguments: { watchId: watch.id },
    });
    expect(cancelled.structuredContent).toMatchObject({ cancelled: true });
  } finally {
    await client.close();
    await listener.stop(true);
    await runner.whenIdle();
    store.close();
  }
  try {
    const reopened = new WatchStore(path, () => Date.parse("2026-10-20T00:00:00Z"));
    try {
      expect(reopened.list()[0]?.status).toBe("cancelled");
      expect(reopened.getAlerts({ after: 0, limit: 50 }).alerts).toHaveLength(1);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
