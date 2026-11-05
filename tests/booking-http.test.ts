import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookingRunner } from "../src/booking-runner";
import { BookingStore } from "../src/booking-store";
import { TmoneyGoAuthClient } from "../src/go-auth";
import { TmoneyGoBusClient } from "../src/go-bus";
import { GoCredentialStore } from "../src/go-credentials";
import { TmoneyGoPurchaseClient } from "../src/go-purchase";
import { TripQueryService } from "../src/query";
import {
  credentials,
  held,
  info,
  initialTime,
  specification,
  trip,
  webTrip,
} from "./booking-fixtures";

test("executes real credential refresh, bus hold, billing and independent receipt clients over synthetic HTTP", async () => {
  // Given
  const directory = mkdtempSync(join(tmpdir(), "booking-http-"));
  const store = new BookingStore(
    join(directory, "booking.sqlite"),
    "synthetic-principal",
    () => initialTime,
  );
  const calls: { readonly path: string; readonly stage: string | undefined }[] = [];
  const identity = {
    ORD_SNO: "synthetic-bus-order",
    LIN_SNO: "synthetic-ticket",
    USR_SNO: credentials.busUserNumber,
    TIM_DTE: "20261030",
    TIM_TIM: "1000",
    TER_SFR: "0000001",
    TER_STO: "0000002",
    SET_NO: "01",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      calls.push({ path, stage: store.records()[0]?.stage });
      if (path.endsWith("uptMbrsAuthTknInfo"))
        return Response.json({ rstCd: "200", dta: { authTkn: "synthetic-refreshed-secret" } });
      if (path.endsWith("selectloadingInfo.do"))
        return Response.json({
          errCode: "00000",
          TER_LIST: [trip.departureTerminal, trip.arrivalTerminal],
        });
      if (path.endsWith("selectIbtList2.do"))
        return Response.json({ errCode: "00000", linelist: [trip.row] });
      if (path.endsWith("selectIbtInfo.do")) return Response.json({ errCode: "00000", ...info });
      if (path.endsWith("updatepcpysats.do"))
        return Response.json({
          errCode: "00000",
          PCPY_LIST: [
            { SATS_NO: "01", SATS_PCPY_ID: held.seats[0]?.holdId, BUS_TCK_KND_CD: "IG00" },
          ],
        });
      if (path.endsWith("inqrPymMnsListAtPym"))
        return Response.json({
          rstCd: "200",
          dta: {
            npayautPymInfo: {
              cardCpNm: "synthetic-card",
              cardNum4th: "9999",
              automaticPayId: "synthetic-billing-secret",
            },
          },
        });
      if (path.endsWith("autoReserve"))
        return Response.json({
          rstCd: "200",
          dta: {
            rspCd: "0000",
            oderSno: "synthetic-payment-order",
            authDataCard: "synthetic-auth-card-secret",
            authDataAuth: "synthetic-auth-secret",
          },
        });
      if (path.endsWith("insertTckCad_CR.do")) return Response.json({ errCode: "00000" });
      if (path.endsWith("selectTckRstStat.do"))
        return Response.json({
          errCode: "00000",
          ORD_SNO: identity.ORD_SNO,
          LIN_SNO: identity.LIN_SNO,
        });
      if (path.endsWith("selectBuyTckInfo2.do"))
        return Response.json({ errCode: "00000", ...identity, ADM_AMT: "15000" });
      if (path.endsWith("selectBuyTckInfoList2.do"))
        return Response.json({
          errCode: "00000",
          TCK_LIST: [
            { ...identity, TCK_FEE: "15000", TISU_ID: "synthetic-issued-ticket", BTK_COD: "IG00" },
          ],
        });
      if (path.endsWith("inqrMbrsBusUtlzList"))
        return Response.json({
          rstCd: "200",
          dta: { busUtlzList: [{ ...identity, BMG_COD: "1", CNT: 1 }] },
        });
      return new Response("Unexpected synthetic endpoint", { status: 404 });
    },
  });
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  try {
    const account = new GoCredentialStore(
      join(directory, "credentials.json"),
      (salt) =>
        new TmoneyGoAuthClient({ salt, fetch: transport, now: () => new Date(initialTime) }),
    );
    await account.save(credentials);
    const query = new TripQueryService(
      {
        async searchTripPage() {
          return {
            trips: [webTrip],
            unavailable: [],
            continuation: null,
            coverage: "end",
            emptyStatus: "none",
          };
        },
        async getSeats() {
          throw new TypeError("One-seat search must not request adjacency");
        },
      },
      () => initialTime,
    );
    const runner = new BookingRunner({
      store,
      query,
      credentials: {
        async read() {
          return { ...(await account.read()), connectionId: credentials.connectionId };
        },
        async refresh() {
          return { ...(await account.refresh()), connectionId: credentials.connectionId };
        },
      },
      bus: new TmoneyGoBusClient({ fetch: transport }),
      purchase: new TmoneyGoPurchaseClient({ fetch: transport }),
      now: () => initialTime,
      ipAddress: () => "",
    });
    const created = await runner.create(specification());
    // When
    await runner.tick();
    // Then
    expect(store.get(created.booking.id)?.stage).toBe("booked");
    expect(calls.filter(({ path }) => path.endsWith("inqrPymMnsListAtPym"))).toEqual([
      { path: "/api/pym/v2/inqrPymMnsListAtPym", stage: "watching" },
      { path: "/api/pym/v2/inqrPymMnsListAtPym", stage: "held" },
    ]);
    expect(calls.filter(({ path }) => path.endsWith("updatepcpysats.do"))).toEqual([
      { path: "/tgx/tgoxzz/ticket/updatepcpysats.do", stage: "holding" },
    ]);
    expect(calls.filter(({ path }) => path.endsWith("autoReserve"))).toEqual([
      { path: "/api/pym/npay/v1/autoReserve", stage: "reserving" },
    ]);
    expect(calls.filter(({ path }) => path.endsWith("insertTckCad_CR.do"))).toEqual([
      { path: "/tgx/tgoxzz/ticket/insertTckCad_CR.do", stage: "issuing" },
    ]);
    expect(calls.at(-1)).toEqual({
      path: "/api/mbrs/v2/inqrMbrsBusUtlzList",
      stage: "reconciling",
    });
    for (const name of readdirSync(directory).filter((name) => name.startsWith("booking.sqlite"))) {
      const data = readFileSync(join(directory, name)).toString("utf8");
      expect(data).not.toMatch(
        /synthetic-(?:secret-token|salt-secret|member-secret|user-secret|billing-secret|auth-card-secret|auth-secret|refreshed-secret)/,
      );
    }
  } finally {
    server.stop(true);
    store.close();
    rmSync(directory, { recursive: true });
  }
});
