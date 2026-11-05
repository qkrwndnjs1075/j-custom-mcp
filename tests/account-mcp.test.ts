import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { TmoneyGoAccountClient } from "../src/go-account";
import { GoAccountService } from "../src/go-session";
import { createHttpHandler } from "../src/http";
import { TmoneyIntercityClient } from "../src/provider";
import { createBusServer } from "../src/tools";
import { TripReferences } from "../src/trip-references";
import { syntheticAuthenticate } from "./mcp-auth-fixture";

async function withAccountMcp(account: GoAccountService, run: (client: Client) => Promise<void>) {
  const token = "synthetic-mcp-token-at-least-32-characters";
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler({
      authenticate: syntheticAuthenticate(token),
      allowedHosts: ["127.0.0.1"],
      createServer: () =>
        createBusServer({
          provider: new TmoneyIntercityClient(),
          references: new TripReferences(),
          account,
        }),
    }),
  });
  const client = new Client({ name: "account-test", version: "1.0" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", listener.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    await run(client);
  } finally {
    await client.close();
    await listener.stop(true);
  }
}

test("account tool refuses credential arguments and reports an unconfigured server", async () => {
  await withAccountMcp(new GoAccountService(), async (client) => {
    const tools = await client.listTools();
    const tool = tools.tools.find((item) => item.name === "get_payment_options");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema.type).toBe("object");
    expect(tool?.inputSchema["anyOf"]).toEqual([
      {
        type: "object",
        properties: { tripRef: expect.objectContaining({ type: "string", format: "uuid" }) },
        required: ["tripRef"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { service: { type: "string", enum: ["intercity", "express"] } },
        required: ["service"],
        additionalProperties: false,
      },
    ]);
    const rejected = await client.callTool({
      name: "get_payment_options",
      arguments: { service: "intercity", token: "synthetic-tool-input" },
    });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).not.toContain("synthetic-tool-input");
    const result = await client.callTool({
      name: "get_payment_options",
      arguments: { service: "intercity" },
    });
    expect(result.structuredContent).toEqual({
      service: "intercity",
      connection: "not_configured",
    });
  });
});

test("HTTP MCP account result excludes provider secrets and handles revoked authentication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "account-mcp-"));
  const sessionPath = join(directory, "session.json");
  let revoked = false;
  let calls = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      calls++;
      if (revoked) return new Response("synthetic-private-error", { status: 401 });
      return Response.json({
        rstCd: "200",
        dta: {
          npayPymInfo: { displayYn: "Y" },
          npayautPymInfo: {
            cardCpNm: "synthetic-private-card",
            cardNum4th: "1234",
            automaticPayId: "synthetic-private-billing-key",
          },
        },
      });
    },
  });
  try {
    await writeFile(
      sessionPath,
      JSON.stringify({
        token: "synthetic-private-session-token",
        appCode: "TEST",
        uuid: "synthetic-private-device",
        appVer: "2.7.1",
        osKnd: "A",
        osVer: "15",
      }),
      { mode: 0o600 },
    );
    const connector = new TmoneyGoAccountClient({
      fetch: Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          return fetch(new Request(new URL(new URL(request.url).pathname, upstream.url), request));
        },
        { preconnect: fetch.preconnect },
      ),
    });
    await withAccountMcp(new GoAccountService(sessionPath, connector), async (client) => {
      const result = await client.callTool({
        name: "get_payment_options",
        arguments: { service: "intercity" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        connection: "connected",
        naverPay: { registration: "registered", billingReferenceAvailable: true },
      });
      expect(JSON.stringify(result)).not.toContain("synthetic-private");
      expect(JSON.stringify(result)).not.toContain("1234");
      revoked = true;
      const expired = await client.callTool({
        name: "get_payment_options",
        arguments: { service: "intercity" },
      });
      expect(expired.isError).toBe(true);
      expect(expired.content).toEqual([
        { type: "text", text: expect.stringContaining('"error":"authentication_required"') },
      ]);
      expect(JSON.stringify(expired)).not.toContain("synthetic-private");
      expect(calls).toBe(2);
    });
  } finally {
    await upstream.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
