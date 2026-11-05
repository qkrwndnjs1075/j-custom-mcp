import { afterEach, expect } from "bun:test";
import { GoBusError, TmoneyGoBusClient } from "../src/go-bus";
import { GoBusContextSchema, GoBusRowSchema } from "../src/go-bus-types";
import { TripSchema } from "../src/provider-types";

export const secret = "synthetic-private-token";
export const context = GoBusContextSchema.parse({
  session: {
    token: secret,
    uuid: "synthetic-device",
    appCode: "MIC",
    appVer: "2.7.1",
    osKnd: "A",
    osVer: "34",
  },
  userNumber: "synthetic-bus-user",
  osRelease: "14",
  country: "KR",
  ipAddress: "",
});
export const web = TripSchema.parse({
  service: "intercity",
  routeId: "00123",
  routeSequence: "01",
  serviceDate: "20261030",
  serviceSequence: "0007",
  departureId: "0000001",
  arrivalId: "0000002",
  departureName: "Synthetic A",
  arrivalName: "Synthetic B",
  scheduledDepartureTime: "093000",
  carrierId: "03",
  busClassId: "1",
  carrierName: "Synthetic",
  busClassName: "Synthetic",
  adultCount: 1,
  studentCount: 0,
  childCount: 0,
  remainingSeats: 3,
  totalSeats: 4,
  departureDate: "20261030",
  departureTime: "093000",
  discountAvailable: "N",
  adultFareKrw: 15000,
});
export const row = GoBusRowSchema.parse({
  rotid: "00123",
  rotsqno: "01",
  alcndt: "20261030",
  alcnsqno: "0007",
  timdte: "20261030",
  timtim: "0930",
  timtimo: "0900",
  terfri: "001",
  tertoi: "002",
  terfro: "099",
  tertoo: "088",
  busgrao: "1",
  corcodo: "03",
  afcownrdvscd: "01",
  adltfee: 15000,
  lintim: "0130",
  tckpay: "Y",
});
export const departureTerminal = { TER_COD: "001", TER_COD2: "0000001", ARPR_TRML_YN: "N" };
export const arrivalTerminal = { TER_COD: "002", TER_COD2: "0000002", ARPR_TRML_YN: "N" };
export const terminalList = [departureTerminal, arrivalTerminal];
export const trip = {
  service: "intercity" as const,
  row,
  expectedAdultFareKrw: 15000,
  expectedTotalFareKrw: 15000,
  departureTerminal,
  arrivalTerminal,
};
export const seatInfo = {
  errCode: "00000",
  TCK_FEE1: "15000",
  TOT_CNT: "4",
  SEAT_LIST: [{ "01": "Y", "02": "N", "03": "?" }],
  DIST: "100",
  IV30_FEE: "10500",
  IV50_FEE: "7500",
  IV70_FEE: "4500",
  BUS_CLS_PRIN_YN: "Y",
  SATS_NO_PRIN_YN: "Y",
};
export const common = {
  CUR_VER: "1729",
  HP_COD: "A",
  IP_ADDRESS: "",
  USR_SNO: context.userNumber,
  OS_VER: "34",
};
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

export function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  timeoutMs = 1000,
  terminals: readonly unknown[] = terminalList,
) {
  const requests: Request[] = [];
  const urls: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      request.url.endsWith("selectloadingInfo.do")
        ? Response.json({ errCode: "00000", TER_LIST: terminals })
        : handler(request),
  });
  servers.push(server);
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      urls.push(request.url);
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  return { client: new TmoneyGoBusClient({ fetch: transport, timeoutMs }), requests, urls };
}

export async function failure(operation: Promise<unknown>, code: GoBusError["code"]) {
  const error: unknown = await operation.then(
    () => null,
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(GoBusError);
  if (!(error instanceof GoBusError)) throw new TypeError("Expected sanitized bus error");
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  expect(`${Bun.inspect(error)} ${JSON.stringify(error)}`).not.toContain(secret);
}
