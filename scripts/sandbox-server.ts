import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AppConfigSchema } from "../src/app-config";
import { createApplication } from "../src/application";
import { AuthTokenStore } from "../src/auth-token-store";
import { UserStore } from "../src/user-store";
import { credentials } from "../tests/booking-fixtures";
import { context } from "../tests/go-express-fixtures";
import { now } from "../tests/go-ticket-fixtures";
import { oauthGrantFixture } from "../tests/oauth-grant-fixture";
import { createSandboxProvider } from "./sandbox-provider";

let active = false;

export async function startSandboxServer(options: { readonly port?: number } = {}) {
  if (active) throw new TypeError("Only one sandbox may run in this process");
  const port = z
    .number()
    .int()
    .min(0)
    .max(65535)
    .parse(options.port ?? 8788);
  active = true;
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const startedAt = originalNow();
  const directory = mkdtempSync(join(tmpdir(), "tmoney-synthetic-sandbox-"));
  Date.now = () => now + originalNow() - startedAt;
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let listener: ReturnType<typeof Bun.serve> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await listener?.stop(true);
      await application?.close();
    } finally {
      globalThis.fetch = originalFetch;
      Date.now = originalNow;
      rmSync(directory, { recursive: true, force: true });
      active = false;
    }
  };
  try {
    const provider = await createSandboxProvider();
    let accessToken: string | undefined;
    listener = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request) {
        if (!application || !accessToken) return new Response("Sandbox starting", { status: 503 });
        if (new URL(request.url).pathname === "/health")
          return Response.json({ status: "ok", mode: "synthetic", liveFinancialCalls: 0 });
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${accessToken}`);
        return application.fetch(new Request(request, { headers }));
      },
    });
    const users = new UserStore(join(directory, "accounts.sqlite"));
    const tokens = new AuthTokenStore(join(directory, "oauth.sqlite"));
    try {
      const user = users.connect({ ...credentials, busUserNumber: context.userNumber });
      accessToken = oauthGrantFixture(
        tokens,
        new URL("/mcp", listener.url).href,
      )(user.userId).access_token;
    } finally {
      users.close();
      tokens.close();
    }
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const request = new Request(input, init);
        if (listener && new URL(request.url).origin === listener.url.origin)
          return originalFetch(new Request(request, { redirect: "manual" }));
        return provider.fetch(request);
      },
      {
        preconnect: () => {
          throw new TypeError("Network preconnect blocked in sandbox");
        },
      },
    );
    const app = await createApplication(
      AppConfigSchema.parse({
        DATA_DIRECTORY: directory,
        MCP_BASE_URL: listener.url.href,
        MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
        MCP_ALLOWED_ORIGINS: "127.0.0.1,localhost",
      }),
    );
    application = app;
    return { url: new URL("/mcp", listener.url), provider, tick: app.tick, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (import.meta.main) {
  const sandbox = await startSandboxServer();
  const timer = setInterval(() => {
    void sandbox.tick().catch(async (error: unknown) => {
      clearInterval(timer);
      await sandbox.close();
      throw error;
    });
  }, 1000);
  console.log(
    `SYNTHETIC ONLY — ${sandbox.url.href}\nTemporary data; clock starts at 2026-10-24 noon KST; all external fetches blocked.\nInspector: Streamable HTTP, no authentication required. Ctrl+C removes temporary data.`,
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      clearInterval(timer);
      void sandbox.close().then(() => process.exit(0));
    });
}
