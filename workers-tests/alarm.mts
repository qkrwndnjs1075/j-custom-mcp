import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { convertV4MiniflareOptions, Headers, Miniflare, type Request, Response } from "miniflare";
import { z } from "zod";

const origin = "https://alarm.example";
const buildDirectory = await mkdtemp(join(tmpdir(), "tmoney-alarm-build-"));
before(async () => {
  await promisify(execFile)(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "--dry-run",
      "--config",
      resolve("workers-tests/wrangler.alarm.jsonc"),
      "--tsconfig",
      resolve("workers-tests/tsconfig.fixture.json"),
      "--outdir",
      buildDirectory,
    ],
    { timeout: 30000 },
  );
});
after(async () => {
  await rm(buildDirectory, { recursive: true, force: true });
});

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(outbound: (request: Request) => Promise<Response>) {
  const directory = await mkdtemp(join(tmpdir(), "tmoney-alarm-state-"));
  const create = () =>
    new Miniflare({
      ...convertV4MiniflareOptions({
        name: "alarm-test",
        modules: true,
        modulesRoot: buildDirectory,
        scriptPath: join(buildDirectory, "alarm-fixture.js"),
        compatibilityDate: "2026-11-05",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          GO_VAULT_KEY: Buffer.alloc(32, 73).toString("base64"),
          MCP_BASE_URL: origin,
          GO_REFRESH_SALT: "synthetic-refresh-salt",
        },
        serviceBindings: { PROVIDER_TRANSPORT: "alarm-test" },
        durableObjects: { APPLICATION: { className: "AlarmTestApplication", useSQLite: true } },
        durableObjectsPersist: directory,
        outboundService: outbound,
      }),
      resourcePersistencePath: directory,
    });
  let worker = create();
  try {
    await worker.ready;
  } catch (error) {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    async request(path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) {
      const headers = new Headers(init?.headers);
      headers.set("host", new URL(origin).host);
      return worker.dispatchFetch(new URL(path, origin), { ...init, headers });
    },
    async restart() {
      await bounded(worker.dispose(), "dispose old workerd");
      worker = create();
      await bounded(worker.ready, "restart workerd");
    },
    async close() {
      await worker.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const alarmSchema = z.object({ alarm: z.number().nullable() });

test("concurrent completed request preserves recovery alarm for pending public request across restart", {
  timeout: 60000,
}, async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const outboundCalls: string[] = [];
  const item = await fixture(async (request) => {
    const url = new URL(request.url);
    outboundCalls.push(`${url.hostname}${url.pathname}`);
    if (url.hostname !== "txbus.t-money.co.kr" || url.pathname !== "/otck/readTrmlList.do")
      return new Response("Denied unexpected outbound", { status: 599 });
    entered.resolve();
    await release.promise;
    return Response.json([{ trml_Cd: "0000001", trml_Nm: "Synthetic", cty_Bus_Area_Nm: "Area" }]);
  });
  try {
    const pending = item
      .request("/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "pending",
          method: "tools/call",
          params: {
            name: "search_terminals",
            arguments: { service: "intercity", query: "Synthetic" },
          },
        }),
      })
      .then(async (response) => {
        await response.text();
      })
      .then(
        () => "completed",
        () => "interrupted",
      );
    await bounded(entered.promise, "provider request entered");
    const before = alarmSchema.parse(await (await item.request("/__test/alarm")).json()).alarm;
    assert.notEqual(before, null, "pending event must pre-arm recovery");
    assert.equal((await bounded(item.request("/health"), "unrelated health request")).status, 200);
    const concurrent = alarmSchema.parse(await (await item.request("/__test/alarm")).json()).alarm;
    assert.notEqual(
      concurrent,
      null,
      "finishing health request must not delete another active event's recovery alarm",
    );
    await item.restart();
    release.resolve();
    await bounded(pending, "interrupted request settles");
    const restarted = alarmSchema.parse(await (await item.request("/__test/alarm")).json()).alarm;
    assert.equal(restarted, concurrent, "recovery alarm must survive process replacement");
    assert.deepEqual(outboundCalls, ["txbus.t-money.co.kr/otck/readTrmlList.do"]);
  } finally {
    release.resolve();
    await item.close();
  }
});

test("production alarm recovers persisted reserving booking without replaying financial mutation", {
  timeout: 30000,
}, async () => {
  const outboundCalls: string[] = [];
  const item = await fixture(async (request) => {
    outboundCalls.push(request.url);
    return new Response("No outbound allowed during reservation recovery", { status: 599 });
  });
  try {
    const seeded = z
      .object({ stage: z.literal("reserving"), issueAttempted: z.literal(false) })
      .parse(await (await item.request("/__test/seed-recovery")).json());
    assert.equal(seeded.stage, "reserving");
    await item.restart();
    assert.equal(
      z.object({ stage: z.string() }).parse(await (await item.request("/__test/recovery")).json())
        .stage,
      "reserving",
    );
    assert.equal(
      (await bounded(item.request("/__test/run-alarm"), "production recovery alarm")).status,
      200,
    );
    const recovered = z
      .object({
        stage: z.literal("uncertain"),
        lastError: z.literal("reconciliation_pending"),
        issueAttempted: z.literal(false),
      })
      .parse(await (await item.request("/__test/recovery")).json());
    assert.equal(recovered.stage, "uncertain");
    assert.deepEqual(
      outboundCalls,
      [],
      "reservation recovery must never retry the financial request",
    );
  } finally {
    await item.close();
  }
});
