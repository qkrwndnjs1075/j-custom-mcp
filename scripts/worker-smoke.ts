import assert from "node:assert/strict";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import ky from "ky";
import { z } from "zod";

const base = new URL(z.url().parse(process.argv[2]));
assert.equal(base.protocol, "https:");
const http = ky.create({ retry: 0, timeout: 45_000, redirect: "manual" });
z.object({ status: z.literal("ok") }).parse(await http.get(new URL("/health", base)).json());
const protectedResponse = await http.post(new URL("/mcp/account", base), {
  throwHttpErrors: false,
  headers: { Accept: "application/json, text/event-stream" },
  json: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
});
assert.equal(protectedResponse.status, 401);
assert.match(protectedResponse.headers.get("www-authenticate") ?? "", /resource_metadata=/);
const metadata = z
  .object({ issuer: z.string() })
  .parse(await http.get(new URL("/.well-known/oauth-authorization-server", base)).json());
assert.equal(metadata.issuer, base.origin);

const client = new Client({ name: "worker-read-only-smoke", version: "1" });
const terminalList = z.object({
  terminals: z.array(z.object({ id: z.string(), name: z.string() })),
});
const summaries: Record<string, unknown>[] = [];
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
  return result.structuredContent;
};
try {
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", base)));
  assert.equal(client.getServerVersion()?.name, "joowon-custom-mcp");
  const inventory = await client.listTools();
  assert.equal(inventory.tools.length, 17);
  await call("get_service_capabilities", {});
  const date = new Date(Date.now() + 86_400_000 + 9 * 3_600_000).toISOString().slice(0, 10);
  for (const service of ["intercity", "express"] as const) {
    const query = service === "intercity" ? "서울남부" : "센트럴";
    const departures = terminalList.parse(await call("search_terminals", { service, query }));
    const departure = departures.terminals[0];
    assert.ok(departure, `${service}: no departure terminal`);
    const arrivals = terminalList.parse(
      await call("search_terminals", {
        service,
        query: "서산",
        departureId: departure.id,
      }),
    );
    const arrival = arrivals.terminals.find((terminal) => terminal.name === "서산");
    assert.ok(arrival, `${service}: no matching arrival terminal`);
    const page = z.object({ trips: z.array(z.object({ tripRef: z.uuid() })) }).parse(
      await call("search_trips", {
        service,
        departureId: departure.id,
        arrivalId: arrival.id,
        date,
        time: "00:00",
        passengers: { adults: 1, students: 0, children: 0 },
      }),
    );
    const first = page.trips[0];
    if (first) await call("get_seats", { tripRef: first.tripRef });
    summaries.push({
      service,
      departure: departure.name,
      arrival: arrival.name,
      date,
      trips: page.trips.length,
      seatsChecked: first !== undefined,
    });
    console.log(JSON.stringify({ providerVerified: summaries.at(-1) }));
  }
  console.log(
    JSON.stringify(
      {
        origin: base.origin,
        health: "ok",
        tools: inventory.tools.length,
        protectedStatus: protectedResponse.status,
        providers: summaries,
        financialCalls: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
