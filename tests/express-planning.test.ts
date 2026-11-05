import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { parseTrips } from "../src/provider-html";
import { TripQueryService } from "../src/query";
import { TripReferences } from "../src/trip-references";
import { evaluateWatch } from "../src/watch-evaluator";
import { WatchRunner } from "../src/watch-runner";
import { WatchStore } from "../src/watch-store";
import {
  ExpressFixtureProvider,
  expressCriteria,
  expressMcp,
  expressSeats,
  expressTrip,
} from "./express-test-fixtures";

const tripResults = z.object({
  service: z.literal("express"),
  trips: z.array(z.object({ service: z.literal("express"), tripRef: z.uuid() })),
});
test.each([
  { name: "search_terminals", arguments: { query: "센트럴" } },
  {
    name: "search_trips",
    arguments: {
      departureId: "021",
      arrivalId: "393",
      date: "2026-10-26",
      time: "14:00",
      passengers: { adults: 1, students: 0, children: 0 },
    },
  },
])("MCP rejects missing service before calling providers: $name", async (request) => {
  // Given a provider whose calls are observable.
  const provider = new ExpressFixtureProvider();
  const mcp = await expressMcp({ provider, references: new TripReferences() });
  try {
    // When a public query omits service.
    const result = await mcp.client.callTool(request);
    // Then no service is inferred and no provider is called.
    expect(result.isError).toBe(true);
    expect(provider.terminalSearches).toHaveLength(0);
    expect(provider.searches).toHaveLength(0);
  } finally {
    await mcp.close();
  }
});

test("MCP search and seat refresh retain express allocation in the same opaque reference", async () => {
  // Given an unquoted express schedule and a real reference store.
  const provider = new ExpressFixtureProvider();
  const references = new TripReferences();
  const mcp = await expressMcp({ provider, references });
  try {
    const result = await mcp.client.callTool({
      name: "search_trips",
      arguments: {
        service: "express",
        departureId: "021",
        arrivalId: "393",
        date: "2026-10-26",
        time: "14:00",
        passengers: { adults: 1, students: 0, children: 0 },
      },
    });
    const found = tripResults.parse(result.structuredContent).trips[0];
    if (!found) throw new TypeError("Expected express trip reference");
    const before = references.get(found.tripRef);
    // When get_seats refreshes the quote through MCP.
    const refreshed = await mcp.client.callTool({
      name: "get_seats",
      arguments: { tripRef: found.tripRef },
    });
    // Then service, opaque ref, and allocation identity survive the quote replacement.
    expect(refreshed.structuredContent).toMatchObject({
      service: "express",
      tripRef: found.tripRef,
      totalFareKrw: 15100,
      totalSeats: 2,
    });
    const after = references.get(found.tripRef);
    expect(after).toMatchObject({
      service: "express",
      tripKey: before?.tripKey,
      totalFareKrw: 15100,
      totalSeats: 2,
    });
    if (before?.service !== "express" || after?.service !== "express")
      throw new TypeError("Lost express service");
    expect(after.expressIdentity).toEqual(before.expressIdentity);
  } finally {
    await mcp.close();
  }
});

test("MCP composes time-feasible same-service express connections", async () => {
  // Given a second express departure after the first leg's110-minute journey.
  const second = expressTrip({
    departureId: "393",
    arrivalId: "010",
    departureName: "서산",
    arrivalName: "서울경부",
    departureTime: "170000",
    scheduledDepartureTime: "170000",
  });
  const provider = new ExpressFixtureProvider([expressTrip(), second]);
  const mcp = await expressMcp({ provider, references: new TripReferences() });
  try {
    // When two express legs are composed through MCP.
    const result = await mcp.client.callTool({
      name: "find_journeys",
      arguments: {
        legs: [
          expressCriteria,
          { ...expressCriteria, departureId: "393", arrivalId: "010", time: "16:30" },
        ],
        maxResults: 10,
        ranking: ["total_fare"],
      },
    });
    // Then one feasible journey carries explicit service on both legs.
    expect(result.structuredContent).toMatchObject({
      complete: true,
      journeys: [{ totalFareKrw: 30200, legs: [{ service: "express" }, { service: "express" }] }],
    });
  } finally {
    await mcp.close();
  }
});

test("MCP does not infer cross-service terminal equivalence from matching names", async () => {
  // Given an intercity leg whose departure name matches the express arrival.
  const base = parseTrips(
    await Bun.file(new URL("fixtures/dispatch.html", import.meta.url)).text(),
  )[0];
  if (!base) throw new TypeError("Missing intercity fixture");
  const second = {
    ...base,
    departureName: "서산",
    departureDate: "20261026",
    departureTime: "180000",
  };
  const provider = new ExpressFixtureProvider([expressTrip(), second]);
  const mcp = await expressMcp({ provider, references: new TripReferences() });
  try {
    // When independently valid mixed-service legs are requested.
    const result = await mcp.client.callTool({
      name: "find_journeys",
      arguments: {
        legs: [
          expressCriteria,
          {
            ...expressCriteria,
            service: "intercity",
            departureId: second.departureId,
            arrivalId: second.arrivalId,
            time: "17:00",
          },
        ],
        maxResults: 10,
        ranking: ["total_fare"],
      },
    });
    // Then no transfer equivalence is invented.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ journeys: [] });
  } finally {
    await mcp.close();
  }
});

test.each([
  {
    passengers: { adults: 0, students: 1, children: 0 },
    adjacent: false,
    reason: "unknown_passenger_fare",
  },
  {
    passengers: { adults: 2, students: 0, children: 0 },
    adjacent: true,
    reason: "unknown_seat_layout",
  },
])("MCP reports incomplete results for %s", async (scenario) => {
  // Given either an unquoted passenger class or unverified physical layout.
  const provider = new ExpressFixtureProvider(
    [expressTrip()],
    expressSeats({ layoutStatus: "unknown", adjacentGroups: [] }),
  );
  const mcp = await expressMcp({ provider, references: new TripReferences() });
  try {
    // When the caller asks for that fare or adjacency constraint.
    const result = await mcp.client.callTool({
      name: "find_journeys",
      arguments: {
        legs: [
          {
            ...expressCriteria,
            passengers: scenario.passengers,
            ...(scenario.adjacent ? { adjacentSeats: 2 } : {}),
          },
        ],
        maxResults: 10,
        ranking: ["total_fare"],
      },
    });
    // Then absence of a proven match is explicitly incomplete.
    expect(result.structuredContent).toMatchObject({
      complete: false,
      journeys: [],
      reasons: [scenario.reason],
    });
  } finally {
    await mcp.close();
  }
});

test("express watch emits an inbox alert retaining service identity", async () => {
  // Given an isolated watch database and an explicit express query.
  const directory = await mkdtemp(join(tmpdir(), "express-watch-"));
  const store = new WatchStore(join(directory, "watch.sqlite"), () =>
    Date.parse("2026-10-24T00:00:00Z"),
  );
  const provider = new ExpressFixtureProvider();
  const query = new TripQueryService(provider);
  const runner = new WatchRunner({
    store,
    evaluate: (criteria, mode) => evaluateWatch(query, criteria, mode),
  });
  const mcp = await expressMcp({
    provider,
    query,
    references: new TripReferences(),
    watches: { store, runner },
  });
  try {
    // When creating an availability watch (initial evaluation completes in this call).
    const created = await mcp.client.callTool({
      name: "watch_trips",
      arguments: {
        criteria: expressCriteria,
        mode: "booking_available",
        intervalSeconds: 300,
        notification: "on_transition",
        retryPolicy: { mode: "fixed_interval" },
        expiresAt: "2026-10-26T23:00:00+09:00",
      },
    });
    expect(created.isError).not.toBe(true);
    // Then its persisted criteria and inbox trip retain the service namespace.
    expect(store.list()[0]?.criteria.service).toBe("express");
    const alerts = await mcp.client.callTool({
      name: "check_alerts",
      arguments: { after: 0, limit: 10 },
    });
    expect(alerts.structuredContent).toMatchObject({
      delivery: "inbox_only",
      alerts: [{ criteria: { service: "express" }, matches: [{ service: "express" }] }],
    });
  } finally {
    await mcp.close();
    await runner.whenIdle();
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
