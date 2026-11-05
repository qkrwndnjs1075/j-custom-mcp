import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { createHttpHandler } from "../src/http";
import { syntheticAuthenticate } from "./mcp-auth-fixture";

const token = "test-token-with-at-least-32-characters";
const createServer = () => {
  const server = new McpServer({ name: "http-test", version: "1.0.0" });
  server.registerTool(
    "echo",
    { inputSchema: z.object({ value: z.string() }) },
    async ({ value }) => ({ content: [{ type: "text", text: value }] }),
  );
  return server;
};
const handler = createHttpHandler({
  createServer,
  authenticate: syntheticAuthenticate(token),
  allowedHosts: ["localhost"],
  allowedOrigins: ["app.vooy.com"],
});

function request(body: unknown, headers?: Record<string, string>) {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      host: "localhost",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function rpc(response: Response): Promise<unknown> {
  const text = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    if (!data) throw new TypeError("Missing SSE result");
    return JSON.parse(data.slice(6));
  }
  return JSON.parse(text);
}

describe("authenticated MCP HTTP", () => {
  test("initializes a real MCP server when authenticated", async () => {
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
    const input = request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    });
    try {
      const response = await fetch(new Request(new URL("/mcp", listener.url), input));
      expect(response.status).toBe(200);
      expect(await rpc(response)).toMatchObject({
        id: 1,
        result: { serverInfo: { name: "http-test" } },
      });
    } finally {
      listener.stop(true);
    }
  });

  test("lists real tools on an independent stateless request", async () => {
    const input = request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const response = await handler(input);
    expect(response.status).toBe(200);
    expect(await rpc(response)).toMatchObject({
      result: { tools: [{ name: "echo" }] },
    });
  });

  test("executes a real tool through the transport", async () => {
    const input = request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo", arguments: { value: "roundtrip" } },
    });
    const response = await handler(input);
    expect(response.status).toBe(200);
    expect(await rpc(response)).toMatchObject({
      result: { content: [{ type: "text", text: "roundtrip" }] },
    });
  });

  test.each(["", "Basic abc", "Bearer wrong", `Bearer ${token} extra`])(
    "rejects missing, wrong, or malformed credentials: %s",
    async (authorization) => {
      const input = request({}, { authorization });
      const response = await handler(input);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="mcp"');
    },
  );

  test.each([
    { host: "evil.example" },
    { host: "" },
    { origin: "https://evil.example" },
    { origin: "null" },
    { origin: "malformed" },
  ])("rejects an untrusted request boundary: %j", async (headers) => {
    const input = request({}, headers);
    const response = await handler(input);
    expect(response.status).toBe(403);
  });

  test("accepts an explicitly allowed Origin", async () => {
    const input = request(
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { origin: "https://app.vooy.com" },
    );
    const response = await handler(input);
    expect(response.status).toBe(200);
    await response.text();
  });

  test.each([
    ["/health", 200],
    ["/other", 404],
  ])("routes %s without authentication", async (path, status) => {
    const input = new Request(`http://localhost${path}`, {
      headers: { host: "localhost" },
    });
    const response = await handler(input);
    expect(response.status).toBe(status);
    if (status === 200) expect(await response.json()).toEqual({ status: "ok" });
  });

  test.each([
    { allowedHosts: [] },
    { allowedHosts: ["*"] },
    { allowedHosts: ["localhost"], allowedOrigins: ["moz-extension://*"] },
  ])("fails configuration with an unsafe allowlist: %j", (allowlist) => {
    expect(() =>
      createHttpHandler({ createServer, authenticate: syntheticAuthenticate(token), ...allowlist }),
    ).toThrow();
  });
});

describe("public MCP authentication routing", () => {
  const publicHandler = createHttpHandler({
    createServer,
    createPublicServer: createServer,
    authenticate: syntheticAuthenticate(token),
    allowedHosts: ["localhost"],
  });
  test.each([
    "{",
    "[]",
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "unknown" }),
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_requests" },
    }),
  ])("requires authentication for nonpublic or malformed envelope %s", async (body) => {
    const input = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body,
    });
    const response = await publicHandler(input);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="mcp"');
  });
  test.each(["", "Bearer invalid", "Basic invalid"])(
    "rejects present invalid credentials on public inventory: %s",
    async (authorization) => {
      const response = await publicHandler(
        request({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization }),
      );
      expect(response.status).toBe(401);
    },
  );
  test("lists public inventory without an authorization header", async () => {
    const input = request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    input.headers.delete("authorization");
    const response = await publicHandler(input);
    expect(response.status).toBe(200);
    expect(await rpc(response)).toMatchObject({ result: { tools: [{ name: "echo" }] } });
  });
});
