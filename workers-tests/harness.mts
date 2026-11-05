import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Headers, Miniflare, type Request, Response } from "miniflare";
import { z } from "zod";

export const origin = "https://mcp.example";
export const key = Buffer.alloc(32, 73).toString("base64");
export const search = {
  service: "intercity",
  departureId: "0671801",
  arrivalId: "3455101",
  date: "2026-10-21",
  time: "11:00",
  passengers: { adults: 1, students: 0, children: 0 },
};

export async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "tmoney-workerd-"));
  const dispatch = await readFile(
    new URL("../tests/fixtures/dispatch.html", import.meta.url),
    "utf8",
  );
  const seats = await readFile(new URL("../tests/fixtures/seats.html", import.meta.url), "utf8");
  const expressRoutes = await readFile(
    new URL("../tests/fixtures/express/routes.json", import.meta.url),
    "utf8",
  );
  const expressSchedule = await readFile(
    new URL("../tests/fixtures/express/schedule.html", import.meta.url),
    "utf8",
  );
  const expressSeats = await readFile(
    new URL("../tests/fixtures/express/seats.html", import.meta.url),
    "utf8",
  );
  const calls: string[] = [];
  const unexpected: string[] = [];
  const members = new Map<string, string>();
  const observers = new Set<() => void>();
  const outbound = async (request: Request) => {
    const url = new URL(request.url);
    calls.push(`${url.hostname}${url.pathname}`);
    for (const observer of observers) observer();
    if (url.hostname === "txbus.t-money.co.kr") {
      if (url.pathname === "/otck/readAlcnList.do" && !request.headers.get("user-agent"))
        return new Response("Provider requires User-Agent", { status: 500 });
      switch (url.pathname) {
        case "/otck/readTrmlList.do":
          return Response.json([
            { trml_Cd: "0671801", trml_Nm: "Departure", cty_Bus_Area_Nm: "Area" },
            { trml_Cd: "3455101", trml_Nm: "Arrival", cty_Bus_Area_Nm: "Area" },
          ]);
        case "/otck/readAlcnList.do":
          return new Response(dispatch);
        case "/otck/readSatsFee.do":
          return new Response(seats);
      }
    }
    if (url.hostname === "www.kobus.co.kr") {
      assert.equal(request.headers.has("authorization"), false);
      assert.equal(request.headers.has("cookie"), false);
      assert.equal(request.headers.get("user-agent"), "Mozilla/5.0");
      assert.equal(request.headers.get("referer"), "https://www.kobus.co.kr/mrs/rotinf.do");
      assert.equal(
        request.headers.get("content-type"),
        "application/x-www-form-urlencoded;charset=UTF-8",
      );
      const form = new URLSearchParams(await request.text());
      if (url.pathname === "/mrs/readRotLinInf.ajax") {
        assert.equal(form.size, 0);
        return new Response(expressRoutes, { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/mrs/alcnSrch.do" || url.pathname === "/mrs/satschc.do") {
        assert.equal(form.get("deprCd"), "021");
        assert.equal(form.get("arvlCd"), "393");
        assert.equal(form.get("deprDtm"), "20261026");
        return new Response(url.pathname === "/mrs/alcnSrch.do" ? expressSchedule : expressSeats);
      }
    }
    if (url.hostname === "tiaapi.tmoney.co.kr") {
      const device = request.headers.get("UUID") ?? "";
      if (url.pathname.endsWith("/toss/auth")) {
        const body = z.object({ userPhone: z.string() }).parse(await request.json());
        const member = body.userPhone === "01011112222" ? "synthetic-alice" : "synthetic-bob";
        members.set(device, member);
        return Response.json({
          rstCd: 200,
          dta: {
            rspCd: "0000",
            data: {
              txId: `tx-${device}`,
              reqSno: `req-${device}`,
              moappMbrsSno: member,
              appScheme: "supertoss://toss-cert/test",
            },
          },
        });
      }
      if (url.pathname.endsWith("/toss/authResult"))
        return Response.json({
          rstCd: 200,
          dta: {
            rspCd: "0000",
            data: {
              prsnAuthScsYn: "Y",
              joinYn: "Y",
              ageDvsCd: "1",
              authTkn: "synthetic-auth-token",
              moappMbrsSno: members.get(device),
            },
          },
        });
      if (url.pathname.endsWith("/uptMbrsAuthTknInfo"))
        return Response.json({ rstCd: 200, dta: { authTkn: "synthetic-refreshed-token" } });
      if (url.pathname.endsWith("/inqrPymMnsListAtPym"))
        return Response.json({
          rstCd: 200,
          dta: {
            npayautPymInfo: {
              cardCpNm: "Synthetic",
              cardNum4th: "0000",
              automaticPayId: "synthetic-billing-id",
            },
          },
        });
    }
    if (url.hostname === "icbusmob.tmoney.co.kr" && url.pathname.endsWith("/getUsrSno.do"))
      return Response.json({
        errCode: "00000",
        USR_SNO: `bus-${members.get(request.headers.get("UUID") ?? "")}`,
      });
    unexpected.push(request.url);
    return new Response("Unexpected outbound denied", { status: 599 });
  };
  const create = (vaultKey = key) =>
    new Miniflare({
      ...convertV4MiniflareOptions({
        name: "integration",
        modules: true,
        scriptPath: resolve("dist/worker/index.js"),
        compatibilityDate: "2026-11-05",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          GO_VAULT_KEY: vaultKey,
          MCP_BASE_URL: origin,
          GO_REFRESH_SALT: "synthetic-refresh-salt",
        },
        serviceBindings: { PROVIDER_TRANSPORT: "integration" },
        durableObjects: { APPLICATION: { className: "TmoneyApplication", useSQLite: true } },
        durableObjectsPersist: directory,
        outboundService: outbound,
      }),
      resourcePersistencePath: directory,
    });
  let worker = create();
  return {
    calls,
    unexpected,
    async nextOutbound() {
      let notify = () => {};
      const event = new Promise<void>((resolve) => {
        notify = resolve;
      });
      observers.add(notify);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          event,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Alarm did not make a provider request")),
              10000,
            );
          }),
        ]);
      } finally {
        observers.delete(notify);
        clearTimeout(timer);
      }
    },
    get worker() {
      return worker;
    },
    async restart(vaultKey = key) {
      await worker.dispose();
      worker = create(vaultKey);
      await worker.ready;
    },
    async request(path: string, init?: Parameters<Miniflare["dispatchFetch"]>[1]) {
      const headers = new Headers(init?.headers);
      headers.set("host", new URL(origin).host);
      return worker.dispatchFetch(new URL(path, origin), { ...init, headers, redirect: "manual" });
    },
    async close() {
      await worker.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
export type Harness = Awaited<ReturnType<typeof harness>>;
const rpcResult = z.object({
  result: z.looseObject({
    protocolVersion: z.string().optional(),
    isError: z.boolean().optional(),
    structuredContent: z.unknown().optional(),
  }),
});
export async function rpc(item: Harness, method: string, params: unknown, token?: string) {
  const response = await item.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-03-26",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method, params }),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  const data = body.startsWith("event:")
    ? body
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6)
    : body;
  assert.ok(data, body);
  return rpcResult.parse(JSON.parse(data)).result;
}
export const tool = (item: Harness, name: string, args: unknown, token?: string) =>
  rpc(item, "tools/call", { name, arguments: args }, token);
