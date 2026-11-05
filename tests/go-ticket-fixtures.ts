import { bookingBinding } from "../src/booking-types";
import { GoBusHttp } from "../src/go-bus-http";
import { GoBusContextSchema } from "../src/go-bus-types";
import type { GoTicket, GoTicketAccount } from "../src/go-ticket-types";
import { TmoneyGoTicketClient } from "../src/go-tickets";
import { credentials } from "./booking-fixtures";

const context = GoBusContextSchema.parse({
  session: credentials,
  userNumber: "bus-member",
  osRelease: "14",
  country: "KR",
  ipAddress: "",
});

export const now = Date.parse("2026-10-24T12:00:00+09:00");
export const account: GoTicketAccount = {
  context,
  memberSerialNumber: "member-fixture",
  bindingHash: bookingBinding({
    ...credentials,
    busUserNumber: context.userNumber,
    moappMbrsSno: "member-fixture",
  }),
};
export function ticket(service: GoTicket["service"]): GoTicket {
  return {
    service,
    lineNumber: "line-1",
    sortDate: "20261023120000",
    ownerUserNumber: "response-owner",
    accountBinding: account.bindingHash,
    departureDate: "20261025",
    departureTime: "140000",
    departureId: service === "express" ? "020" : "1000001",
    arrivalId: service === "express" ? "010" : "1000002",
    departureName: "서산",
    arrivalName: "센트럴시티",
    paymentCode: "N",
    statusCode: "1",
    count: 2,
  };
}
export function native(service: GoTicket["service"]) {
  const target = ticket(service);
  return {
    LIN_SNO: target.lineNumber,
    USR_SNO: target.ownerUserNumber,
    TIM_DTE: target.departureDate,
    TIM_TIM: target.departureTime,
    TER_SFR: target.departureId,
    TER_STO: target.arrivalId,
    ORD_SNO: "order-1",
    SORT_DTE: target.sortDate,
    BMG_COD: "1",
    ADM_KND_COD: "N",
    FR_NAM: "서산",
    TO_NAM: "센트럴시티",
    CNT: "2",
    SET_NO: "01,02",
    TCK_PUB_DIV_COD: "M",
  };
}
export function candidate(service: GoTicket["service"], seat: number) {
  const row = native(service);
  return {
    USR_SNO: row.USR_SNO,
    LIN_SNO: row.LIN_SNO,
    ORD_SNO: row.ORD_SNO,
    TER_SFR: row.TER_SFR,
    TER_STO: row.TER_STO,
    SET_NO: String(seat).padStart(2, "0"),
    TISU_ID: `issuance-${seat}`,
    TCK_SEQ: String(seat),
    ...(service === "intercity"
      ? { PUB_DTE: "20261023", PUB_TER: "0001", PUB_WIN: "02", PUB_SNO: "pub-1" }
      : { ACT_DTE: "20261023", TCK_TER: "020", TCK_WIN: `window-${seat}` }),
  };
}
export function issued(service: GoTicket["service"], seat: number) {
  return {
    ...native(service),
    SET_NO: String(seat).padStart(2, "0"),
    TISU_ID: `issuance-${seat}`,
    DSC_TCK: "N",
    DCT_COD: "0",
  };
}
export type FixtureEdit = (path: string, response: Readonly<Record<string, unknown>>) => unknown;
export function rotatingIntercityFixture(edit?: FixtureEdit) {
  let responseNumber = 0;
  return fixture("intercity", (path, response) => {
    const project = (value: unknown) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
      return {
        ...value,
        USR_SNO: `opaque-response-${++responseNumber}`,
        ...(path === "selectBuyTckInfoList2.do" ? { ORD_SNO: undefined } : {}),
        ...(path === "selectCanTckList.do" ? { TCK_SEQ: undefined } : {}),
      };
    };
    const rotated = {
      ...response,
      USR_SNO: `opaque-response-${++responseNumber}`,
      ...Object.fromEntries(
        Object.entries(response)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [key, Array.isArray(value) ? value.map(project) : value]),
      ),
    };
    return edit ? edit(path, rotated) : rotated;
  });
}
export function fixture(service: GoTicket["service"], edit?: FixtureEdit) {
  const requests: { readonly url: string; readonly body: Readonly<Record<string, unknown>> }[] = [];
  const state = { cancelled: false, seats: [1, 2] };
  const transport: typeof globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const raw: unknown = await request.json();
      const body = Object.fromEntries(
        Object.entries(typeof raw === "object" && raw !== null ? raw : {}),
      );
      requests.push({ url: request.url, body });
      const path = new URL(request.url).pathname.split("/").at(-1) ?? "";
      const base = native(service);
      const remaining = [1, 2].filter((seat) => !state.cancelled || !state.seats.includes(seat));
      const event = {
        ...base,
        BMG_COD: "4",
        SORT_DTE: "20261024120001",
        CNT: String(state.seats.length),
      };
      let response: Readonly<Record<string, unknown>>;
      switch (path) {
        case "selectMyPagePayList.do":
        case "selectMyPagePayListSecu.do":
          response = {
            payList: state.cancelled
              ? [...(remaining.length ? [{ ...base, CNT: String(remaining.length) }] : []), event]
              : [base],
          };
          break;
        case "selectBuyTckInfo2.do":
          response = base;
          break;
        case "selectBuyTckInfoList2.do":
          response = { tckList: remaining.map((seat) => issued(service, seat)) };
          break;
        case "selectCanTckList.do":
          response = { ticketList: remaining.map((seat) => candidate(service, seat)) };
          break;
        case "selectFeeInfo.do":
          response = { canFee: "1000", tckFee: service === "express" ? "20000" : "19000" };
          break;
        case "insertTckCanCad2.do":
          state.cancelled = true;
          state.seats = String(body["SET_NO"] ?? body["set_no"])
            .split(":")
            .map(Number);
          response = { canRegDte: "20261024120001" };
          break;
        case "tckResponse.do":
          response = {};
          break;
        case "selectMyPagePayInfo2.do":
          response = {
            ...event,
            SET_NO: state.seats.map((seat) => String(seat).padStart(2, "0")).join(","),
            PEP_CHA: "1000",
            CAN_FEE: "19000",
            CAN_DTE: "20261024",
            CAN_TIM: "120001",
          };
          break;
        default:
          throw new TypeError(`Unexpected endpoint ${path}`);
      }
      const result = edit
        ? edit(path, { errCode: "00000", ...response })
        : { errCode: "00000", ...response };
      if (result instanceof Response) return result;
      return Response.json(result);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  return {
    client: new TmoneyGoTicketClient({ http: new GoBusHttp({ fetch: transport }), now: () => now }),
    requests,
    state,
    transport,
  };
}
