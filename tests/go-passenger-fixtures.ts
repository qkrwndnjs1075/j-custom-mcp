import { TmoneyGoBusClient } from "../src/go-bus";
import { GoBusContextSchema, type GoBusHold, GoBusRowSchema } from "../src/go-bus-types";
import { TmoneyGoPurchaseClient } from "../src/go-purchase";

export const context = GoBusContextSchema.parse({
  session: {
    token: "synthetic",
    uuid: "device",
    appCode: "MIC",
    appVer: "2.7.1",
    osKnd: "A",
    osVer: "34",
  },
  userNumber: "user",
  osRelease: "14",
  country: "KR",
  ipAddress: "",
});
export const trip = {
  service: "intercity" as const,
  row: GoBusRowSchema.parse({
    rotid: "route",
    rotsqno: "01",
    alcndt: "20261030",
    alcnsqno: "01",
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
  expectedTotalFareKrw: 44500,
  passengers: { adults: 2, students: 1, children: 1 },
  fareQuotes: {
    adults: { unitFareKrw: 15000, fareKindCode: "IG00" },
    children: { unitFareKrw: 7500, fareKindCode: "IC50" },
    students: { unitFareKrw: 7000, fareKindCode: "IM30" },
  },
  departureTerminal: { TER_COD: "001", TER_COD2: "0000001", ARPR_TRML_YN: "N" },
  arrivalTerminal: { TER_COD: "002", TER_COD2: "0000002", ARPR_TRML_YN: "N" },
};
export const info = {
  tckfee1: "15000",
  tckfee2: "7500",
  tckfee91: "9000",
  tckfee92: "8000",
  tckfee93: "7000",
  totcnt: "4",
  seatlist: [{ "01": "Y", "02": "Y", "03": "Y", "04": "Y" }],
  DIST: "100",
};
export const held = {
  trip,
  info,
  seats: [
    { seat: "01", holdId: "h1", ticketKind: "IC50", passengerType: "child" },
    { seat: "02", holdId: "h2", ticketKind: "IG00", passengerType: "adult" },
    { seat: "03", holdId: "h3", ticketKind: "IM30", passengerType: "student" },
    { seat: "04", holdId: "h4", ticketKind: "IG00", passengerType: "adult" },
  ],
} as const satisfies GoBusHold;
export const selection = [
  { seat: 4, passengerType: "adult" },
  { seat: 1, passengerType: "child" },
  { seat: 3, passengerType: "student" },
  { seat: 2, passengerType: "adult" },
] as const;
export const holdResponse = {
  ERR_COD: "00000",
  PCPY_LIST: [
    { SATS_NO: "01", SATS_PCPY_ID: "h1", BUS_TCK_KND_CD: "IC50" },
    { SATS_NO: "02", SATS_PCPY_ID: "h2", BUS_TCK_KND_CD: "IG00" },
    { SATS_NO: "03", SATS_PCPY_ID: "h3", BUS_TCK_KND_CD: "IM30" },
    { SATS_NO: "04", SATS_PCPY_ID: "h4", BUS_TCK_KND_CD: "IG00" },
  ],
};
const servers: ReturnType<typeof Bun.serve>[] = [];
export function stopFixtures() {
  for (const server of servers.splice(0)) server.stop(true);
}
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
  return {
    requests,
    bus: new TmoneyGoBusClient({ fetch: transport }),
    purchase: new TmoneyGoPurchaseClient({ fetch: transport }),
  };
}
