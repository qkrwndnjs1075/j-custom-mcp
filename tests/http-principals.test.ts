import { expect, test } from "bun:test";
import { type AuthInfo, McpServer } from "@modelcontextprotocol/server";
import { createHttpHandler } from "../src/http";

const first = crypto.randomUUID();
const second = crypto.randomUUID();
function request(subject: string, bodySubject = "forged-client-subject") {
  return new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      host: "localhost",
      authorization: `Bearer ${subject}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-user-id": bodySubject,
      "mcp-session-id": bodySubject,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: subject,
      method: "tools/call",
      params: { name: "identity", arguments: {}, _meta: { subject: bodySubject } },
    }),
  });
}
function identityServer(auth: AuthInfo) {
  const server = new McpServer({ name: "identity", version: "1.0" });
  server.registerTool("identity", {}, async (context) => {
    await Promise.resolve();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ factory: auth.extra, handler: context.http?.authInfo?.extra }),
        },
      ],
    };
  });
  return server;
}
test("concurrent requests keep verified principal in factory and SDK tool context", async () => {
  const seen: AuthInfo[] = [];
  const handler = createHttpHandler({
    allowedHosts: ["localhost"],
    authenticate: async (input) => {
      const subject = input.headers.get("authorization") === `Bearer ${first}` ? first : second;
      await Promise.resolve();
      return {
        token: "verified-opaque",
        clientId: "one-shared-oauth-client",
        scopes: ["mcp"],
        extra: { subject },
      };
    },
    createServer: (auth) => {
      seen.push(auth);
      return identityServer(auth);
    },
  });
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  try {
    const results = await Promise.all(
      [first, second].map(async (subject) => {
        const response = await fetch(new Request(new URL("/mcp", listener.url), request(subject)));
        if (response.status !== 200) throw new Error(await response.text());
        expect(response.status).toBe(200);
        return response.text();
      }),
    );
    expect(seen).toHaveLength(2);
    expect(results[0]).toContain(first);
    expect(results[0]).not.toContain(second);
    expect(results[1]).toContain(second);
    expect(results[1]).not.toContain(first);
    for (const result of results) {
      expect(result).toContain("factory");
      expect(result).toContain("handler");
      expect(result).not.toContain("forged-client-subject");
    }
  } finally {
    listener.stop(true);
  }
});
test("invalid trusted subject and rejected authentication never construct a server", async () => {
  for (const authentication of [
    { token: "opaque", clientId: first, scopes: ["mcp"], extra: { subject: "invalid" } },
    { token: "opaque", clientId: first, scopes: ["mcp"] },
    new Response("Unauthorized", { status: 401 }),
  ]) {
    let constructed = false;
    const handler = createHttpHandler({
      allowedHosts: ["localhost"],
      authenticate: async () => authentication,
      createServer: (auth) => {
        constructed = true;
        return identityServer(auth);
      },
    });
    expect((await handler(request(first, first))).status).toBe(401);
    expect(constructed).toBe(false);
  }
});
test("public handlers run after boundaries and thrown failures never disclose secrets", async () => {
  let calls = 0;
  const handler = createHttpHandler({
    allowedHosts: ["localhost"],
    authenticate: async () => {
      throw new Error("private-token-upstream-stack");
    },
    createServer: identityServer,
    publicHandlers: [
      async (input) => {
        calls++;
        return new URL(input.url).pathname === "/oauth/public" ? new Response("public") : undefined;
      },
    ],
  });
  expect(
    (
      await handler(
        new Request("http://localhost/oauth/public", { headers: { host: "evil.example" } }),
      )
    ).status,
  ).toBe(403);
  expect(calls).toBe(0);
  expect(
    await (
      await handler(
        new Request("http://localhost/oauth/public", { headers: { host: "localhost" } }),
      )
    ).text(),
  ).toBe("public");
  const rejected = await handler(request(first));
  expect(rejected.status).toBe(503);
  expect(await rejected.text()).toBe("Service unavailable");
});
