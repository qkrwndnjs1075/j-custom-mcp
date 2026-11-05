import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { BookingRunner } from "../src/booking-runner";
import { BookingStore } from "../src/booking-store";
import { TmoneyGoBusClient } from "../src/go-bus";
import { TmoneyGoPurchaseClient } from "../src/go-purchase";
import { createHttpHandler } from "../src/http";
import { SeatMapSchema } from "../src/provider-types";
import { TripQueryService } from "../src/query";
import { createBusServer } from "../src/tools";
import { TripReferences } from "../src/trip-references";
import { UserIdSchema } from "../src/user-types";
import { credentials } from "./booking-fixtures";
import { publicProvider, publicExpressTrip as publicProviderTrip } from "./express-booking-inputs";
import { context, response } from "./go-express-fixtures";

export {
  directInput,
  expressSearch,
  expressSpec,
  publicProvider,
  quotedReference,
} from "./express-booking-inputs";

const subjectA = UserIdSchema.parse("31ce88aa-f5b5-48d6-a0d1-d9e9a75db6ba");
const subjectB = UserIdSchema.parse("dc82f590-0713-4bd9-8d84-f16e546f94c9");
const endpoints = [
  "selectTimInfo2.do",
  "selectArrInfo.do",
  "insertPcpyNo.do",
  "deletePcpyNo.do",
  "inqrPymMnsListAtPym",
  "autoReserve",
  "insertTckCad_CR.do",
  "selectTckRstStat.do",
  "selectBuyTckInfo2.do",
  "selectBuyTckInfoList2.do",
  "selectBuyTckListSecu.do",
];

export async function expressBookingFixture() {
  const localFetch = globalThis.fetch;
  const directory = mkdtempSync(join(tmpdir(), "express-booking-http-"));
  const state = {
    now: Date.parse("2026-10-30T12:00:00+09:00"),
    paymentAvailable: true,
    quoteAvailable: true,
    issueFails: false,
    receiptsAvailable: true,
    issued: false,
    priorIdenticalReceipt: false,
    connection: "express-original-connection",
  };
  const calls: {
    readonly path: string;
    readonly origin: string;
    readonly body: Record<string, unknown>;
  }[] = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (!endpoints.some((endpoint) => path.endsWith(endpoint)))
        return new Response("Blocked unknown synthetic endpoint", { status: 500 });
      if (path.endsWith("inqrPymMnsListAtPym") && !state.paymentAvailable)
        return Response.json({ rstCd: "200", dta: {} });
      if (path.endsWith("selectBuyTckListSecu.do") && !state.issued && !state.priorIdenticalReceipt)
        return Response.json({ errCode: "00000", ticketList: [] });
      if (path.endsWith("insertTckCad_CR.do")) {
        state.issued = true;
        if (state.issueFails) return new Response("Synthetic unknown outcome", { status: 503 });
      }
      if (path.endsWith("selectTckRstStat.do") && !state.receiptsAvailable)
        return Response.json({ errCode: "00000" });
      return response(request);
    },
  });
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (!["exp.tmoney.co.kr", "tiaapi.tmoney.co.kr"].includes(url.hostname))
        throw new TypeError("External request blocked by synthetic fixture");
      calls.push({
        path: url.pathname,
        origin: url.origin,
        body: z.record(z.string(), z.unknown()).parse(await request.clone().json()),
      });
      return localFetch(new Request(new URL(url.pathname, upstream.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  const provider = {
    ...publicProvider,
    async getSeats() {
      if (state.quoteAvailable) return publicProvider.getSeats(publicProviderTrip);
      return SeatMapSchema.parse({
        adultFareKrw: null,
        fareQuotes: { adults: null, students: null, children: null },
        seats: [1, 3, 4].map((number) => ({ number, available: true })),
      });
    },
  };
  const query = new TripQueryService(provider, () => state.now);
  const tenants = [subjectA, subjectB].map((subject) => {
    const path = join(directory, `${subject}.sqlite`);
    const store = new BookingStore(path, subject, () => state.now);
    const options = {
      query,
      credentials: {
        async read() {
          return {
            ...credentials,
            busUserNumber: context.userNumber,
            connectionId: `${state.connection}:${subject}`,
          };
        },
        async refresh() {
          return this.read();
        },
      },
      bus: new TmoneyGoBusClient({ fetch: transport }),
      purchase: new TmoneyGoPurchaseClient({ fetch: transport }),
      now: () => state.now,
      ipAddress: () => "",
    };
    return {
      subject,
      path,
      store,
      options,
      runner: new BookingRunner({ ...options, store }),
      references: new TripReferences(() => state.now),
    };
  });
  const [first, second] = tenants;
  if (!first || !second) throw new TypeError("Missing synthetic tenants");
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createHttpHandler({
      allowedHosts: ["127.0.0.1"],
      authenticate: async (request) => {
        const token = request.headers.get("authorization");
        const subject =
          token === "Bearer synthetic-a"
            ? subjectA
            : token === "Bearer synthetic-b"
              ? subjectB
              : null;
        if (!subject) return new Response("Unauthorized", { status: 401 });
        return {
          token: token ?? "",
          clientId: "synthetic-express",
          scopes: ["mcp"],
          extra: { subject },
        };
      },
      createServer: (auth) => {
        const { subject } = z.object({ subject: UserIdSchema }).parse(auth.extra);
        const tenant = tenants.find((entry) => entry.subject === subject);
        if (!tenant) throw new TypeError("Unknown synthetic subject");
        return createBusServer({
          provider,
          query,
          references: tenant.references,
          bookings: () => ({ store: tenant.store, runner: tenant.runner }),
        });
      },
    }),
  });
  const clients: Client[] = [];
  for (const token of ["synthetic-a", "synthetic-b"]) {
    const client = new Client({ name: "express-booking-http", version: "1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", listener.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    clients.push(client);
  }
  const [client, otherClient] = clients;
  if (!client || !otherClient) throw new TypeError("Missing synthetic clients");
  return {
    state,
    calls,
    client,
    otherClient,
    first,
    second,
    transport,
    async restart() {
      await first.runner.whenIdle();
      first.store.close();
      first.store = new BookingStore(first.path, first.subject, () => state.now);
      first.runner = new BookingRunner({ ...first.options, store: first.store });
    },
    async close() {
      await Promise.all(clients.map((entry) => entry.close()));
      listener.stop(true);
      upstream.stop(true);
      for (const tenant of tenants) tenant.store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
