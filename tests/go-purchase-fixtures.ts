import { afterEach } from "bun:test";
import { GoBusContextSchema, type GoBusHold, GoBusRowSchema } from "../src/go-bus-types";
import { TmoneyGoPurchaseClient } from "../src/go-purchase";

export const secret = "synthetic-payment-private";
export const context = GoBusContextSchema.parse({
  session: {
    token: secret,
    uuid: "device",
    appCode: "MIC",
    appVer: "2.7.1",
    osKnd: "A",
    osVer: "34",
  },
  userNumber: "bus-member",
  osRelease: "14",
  country: "KR",
  ipAddress: "",
});
export const hold = {
  trip: {
    service: "intercity",
    row: GoBusRowSchema.parse({
      rotid: "00123",
      rotsqno: "01",
      alcndt: "20261030",
      alcnsqno: "07",
      timdte: "20261030",
      timtim: "0930",
      timtimo: "0900",
      terfri: "001",
      tertoi: "002",
      terfro: "0001",
      tertoo: "0002",
      busgrao: "1",
      corcodo: "03",
      afcownrdvscd: "01",
      adltfee: 15000,
      lintim: "0130",
      tckpay: "Y",
    }),
    expectedAdultFareKrw: 15000,
    expectedTotalFareKrw: 15000,
    departureTerminal: { TER_COD: "001", ARPR_TRML_YN: "N" },
    arrivalTerminal: { TER_COD: "002", ARPR_TRML_YN: "N" },
  },
  info: {
    tckfee1: "15000",
    totcnt: "4",
    seatlist: [{ "01": "Y" }],
    DIST: "100",
    tckfee91: "5000",
    tckfee92: "6000",
  },
  seats: [{ seat: "01", holdId: "synthetic-hold", ticketKind: "IG00", passengerType: "adult" }],
} as const satisfies GoBusHold;
export const registered = {
  rstCd: "200",
  dta: { npayautPymInfo: { cardCpNm: secret, cardNum4th: "9999", automaticPayId: secret } },
};
export const reserved = {
  rstCd: "200",
  dta: { rspCd: "0000", oderSno: "order-1", authDataCard: secret, authDataAuth: secret },
};
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

export function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  return { client: new TmoneyGoPurchaseClient({ fetch: transport }), requests };
}
export function basicResponse(request: Request) {
  if (request.url.includes("inqrPym")) return Response.json(registered);
  if (request.url.includes("autoReserve")) return Response.json(reserved);
  return Response.json({ ERR_COD: "00000" });
}
export async function reservedFixture(handler = basicResponse) {
  const fake = fixture(handler);
  const prepared = await fake.client.prepare(context, hold, "go-member");
  const reservation = await fake.client.reserve(context, prepared);
  return { ...fake, prepared, reservation };
}
