import { expect, test } from "bun:test";
import { KobusExpressClient } from "../src/express-provider";
import { ProviderError } from "../src/provider-types";

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/express/${name}`, import.meta.url)).text();
const search = {
  service: "express",
  departureId: "021",
  arrivalId: "393",
  date: "2026-10-26",
  time: "14:00",
  passengers: { adults: 1, students: 0, children: 0 },
} as const;

test("uses only catalog and schedule requests with compact dates when searching trips", async () => {
  // Given a real local HTTP server serving captured provider responses.
  const requests: { path: string; body: URLSearchParams }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({ path, body: new URLSearchParams(await request.text()) });
      switch (path) {
        case "/mrs/readRotLinInf.ajax":
          if (request.headers.get("accept")?.startsWith("text/")) {
            return new Response(null, { status: 302, headers: { Location: "/error/error.html" } });
          }
          return new Response(await fixture("routes.json"));
        case "/mrs/alcnSrch.do":
          return new Response(await fixture("schedule.html"));
        default:
          return new Response("Unexpected endpoint", { status: 400 });
      }
    },
  });
  try {
    const client = new KobusExpressClient((input, init) => {
      const request = new Request(input, init);
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    });
    // When the public adapter searches through its actual HTTP transport.
    const page = await client.searchTripPage(search);
    // Then one catalog and one schedule request suffice, without seat/hold fanout.
    expect(page.trips.length).toBeGreaterThan(0);
    expect(requests.map((request) => request.path)).toEqual([
      "/mrs/readRotLinInf.ajax",
      "/mrs/alcnSrch.do",
    ]);
    expect(requests[1]?.body.get("deprDtm")).toBe("20261026");
  } finally {
    await server.stop(true);
  }
});

test("filters arrival terminals by the selected departure route", async () => {
  // Given the captured public route catalog through an injected transport.
  const client = new KobusExpressClient(async () => new Response(await fixture("routes.json")));
  // When resolving Seosan on Central City routes.
  const terminals = await client.searchTerminals({
    service: "express",
    departureId: "021",
    query: "서산",
  });
  // Then the exact express terminal is returned without an intercity alias.
  expect(terminals.map((terminal) => String(terminal.id))).toEqual(["393"]);
});

test("reports upstream errors without retrying", async () => {
  // Given a provider returning a failed HTTP response.
  let calls = 0;
  const client = new KobusExpressClient(async () => {
    calls++;
    return new Response("Unavailable", { status: 503 });
  });
  // When the catalog lookup fails.
  const result = client.searchTerminals({ service: "express", query: "서산" });
  // Then the typed error is exposed and retry policy is observed.
  await expect(result).rejects.toMatchObject({ code: "http" });
  expect(calls).toBe(1);
});

test("rejects invalid route JSON instead of silently reporting no terminals", async () => {
  // Given markup instead of the official JSON catalog.
  const client = new KobusExpressClient(async () => new Response("<html>blocked</html>"));
  // When/Then the response fails closed.
  await expect(client.searchTerminals({ service: "express", query: "서산" })).rejects.toThrow(
    ProviderError,
  );
});
