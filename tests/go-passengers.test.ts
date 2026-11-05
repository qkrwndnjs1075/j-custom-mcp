import { afterEach, expect, test } from "bun:test";
import type { GoBusHold } from "../src/go-bus-types";
import { buildGoIssueBody, GoPurchaseHoldSchema } from "../src/go-purchase-types";
import {
  context,
  fixture,
  held,
  holdResponse,
  info,
  selection,
  stopFixtures,
  trip,
} from "./go-passenger-fixtures";

afterEach(stopFixtures);

function busResponse(request: Request) {
  return Response.json(
    request.url.endsWith("selectIbtInfo.do") ? { ERR_COD: "00000", ...info } : holdResponse,
  );
}
test("preserves caller seat/category pairs in sorted multi-seat wire order", async () => {
  // Given
  const fake = fixture(busResponse);
  // When
  const result = await fake.bus.hold(context, { trip, seats: selection });
  // Then
  expect(result).toEqual(held);
  expect(await fake.requests[1]?.json()).toMatchObject({
    SATS_PCPY_NUM: "4",
    SATS_NO: "01:02:03:04",
    BUS_TCK_KND_CD: "IC50:IG00:IM30:IG00",
    CTY_BUS_DC_KND_CD: ":::",
    DCRT_DVS_CD: ":::",
  });
});
test("releases every actual returned hold identity with matching seats", async () => {
  // Given
  const fake = fixture(() => Response.json({ ERR_COD: "00000" }));
  // When
  await fake.bus.release(context, held);
  // Then
  expect(await fake.requests[0]?.json()).toMatchObject({
    SATS_PCPY_NUM: "4",
    SATS_NO: "01:02:03:04",
    SATS_PCPY_ID: "h1:h2:h3:h4",
    BUS_TCK_KND_CD: "IC50:IG00:IM30:IG00",
    SATS_PCPY_DVS: "2",
  });
});
test("rejects changed total before the seat mutation", async () => {
  // Given
  const fake = fixture(busResponse);
  // When
  const action = fake.bus.hold(context, {
    trip: { ...trip, expectedTotalFareKrw: 45000 },
    seats: selection,
  });
  // Then
  await expect(action).rejects.toMatchObject({ code: "fare_changed" });
  expect(fake.requests).toHaveLength(1);
});
test("preserves uncertainty when provider assigns a different passenger type", async () => {
  // Given
  const fake = fixture((request) =>
    request.url.endsWith("selectIbtInfo.do")
      ? busResponse(request)
      : Response.json({
          ...holdResponse,
          PCPY_LIST: holdResponse.PCPY_LIST.map((seat) => ({ ...seat, BUS_TCK_KND_CD: "IG00" })),
        }),
  );
  // When
  const action = fake.bus.hold(context, { trip, seats: selection });
  // Then
  await expect(action).rejects.toMatchObject({ code: "hold_uncertain" });
  expect(fake.requests).toHaveLength(2);
});
test("reserves and issues the full mixed passenger count and total", async () => {
  // Given
  const fake = fixture((request) =>
    Response.json(
      request.url.includes("inqrPym")
        ? {
            rstCd: "200",
            dta: {
              npayautPymInfo: {
                cardCpNm: "synthetic",
                cardNum4th: "0000",
                automaticPayId: "synthetic",
              },
            },
          }
        : request.url.includes("autoReserve")
          ? {
              rstCd: "200",
              dta: {
                rspCd: "0000",
                oderSno: "payment",
                authDataCard: "synthetic",
                authDataAuth: "synthetic",
              },
            }
          : { ERR_COD: "00000" },
    ),
  );
  const prepared = await fake.purchase.prepare(context, held, "member");
  const reserved = await fake.purchase.reserve(context, prepared);
  // When
  await fake.purchase.issue(context, held, reserved);
  // Then
  expect(await fake.requests[1]?.json()).toMatchObject({ productCount: 4, productAmount: 44500 });
  expect(await fake.requests[2]?.json()).toMatchObject({
    TOT_AMT: "44500",
    CNT_100: "2",
    CNT_050: "1",
    AMT_050: "0",
    AMT_100: "1",
    TCK_FEE1: "15000",
    TCK_FEE2: "7500",
    TCK_FEE8: "0",
    TCK_FEE9: "7000",
    FEE9_TYPE: "3",
    SET_NO_WEB: "01:02:03:04",
    SATS_PCPY_ID: "h1:h2:h3:h4",
  });
});
for (const [kind, fee, infoPatch, feeType] of [
  ["IM20", 8000, { tckfee93: "0" }, "2"],
  ["IM10", 9000, { tckfee93: "0", tckfee92: "0" }, "1"],
] as const) {
  test(`uses the held ${kind} category for student unit fare and FEE9_TYPE`, () => {
    // Given
    const hold: GoBusHold = {
      ...held,
      trip: {
        ...trip,
        expectedTotalFareKrw: fee,
        passengers: { adults: 0, students: 1, children: 0 },
        fareQuotes: { ...trip.fareQuotes, students: { unitFareKrw: fee, fareKindCode: kind } },
      },
      info: { ...info, ...infoPatch },
      seats: [{ seat: "03", holdId: "h3", ticketKind: kind, passengerType: "student" }],
    };
    // When
    const body = buildGoIssueBody(hold);
    // Then
    expect(body).toMatchObject({
      TOT_AMT: String(fee),
      FEE9_TYPE: feeType,
      TCK_FEE9: String(fee),
      TCK_FEE1: "0",
      AMT_100: "1",
      CNT_100: "0",
    });
  });
}
const identity = {
  ORD_SNO: "order",
  LIN_SNO: "line",
  USR_SNO: "user",
  TIM_DTE: "20261030",
  TIM_TIM: "0930",
  TER_SFR: "001",
  TER_STO: "002",
};
const ticketRows = [
  { ...identity, SET_NO: "1", BTK_COD: "IC50", TCK_FEE: "7500", TISU_ID: "issued1" },
  { ...identity, SET_NO: "2", BTK_COD: "IG00", TCK_FEE: "15000", TISU_ID: "issued2" },
  { ...identity, SET_NO: "3", BTK_COD: "IM30", TCK_FEE: "7000", TISU_ID: "issued3" },
  { ...identity, SET_NO: "4", BTK_COD: "IG00", TCK_FEE: "15000", TISU_ID: "issued4" },
];
function reconcileResponse(request: Request) {
  if (request.url.includes("selectTckRstStat"))
    return Response.json({ ERR_COD: "00000", ORD_SNO: "order", LIN_SNO: "line" });
  if (request.url.includes("selectBuyTckInfo2"))
    return Response.json({ ERR_COD: "00000", ...identity, SET_NO: "1,2,3,4", ADM_AMT: "44500" });
  if (request.url.includes("selectBuyTckInfoList2"))
    return Response.json({ ERR_COD: "00000", TCK_LIST: ticketRows });
  return Response.json({
    rstCd: "200",
    dta: { busUtlzList: [{ ...identity, BMG_COD: "1", CNT: 4 }] },
  });
}
const lookup = { hold: held, memberSerialNumber: "member", purchaseMonth: "202610" };
test("confirms all mixed tickets only after detail list and history agree", async () => {
  // Given
  const fake = fixture(reconcileResponse);
  // When
  const result = await fake.purchase.reconcile(context, lookup);
  // Then
  expect(result).toMatchObject({
    status: "confirmed",
    fareKrw: 44500,
    tickets: [
      { ticketNumber: "issued1", seat: "01", fareKrw: 7500 },
      { ticketNumber: "issued2", seat: "02", fareKrw: 15000 },
      { ticketNumber: "issued3", seat: "03", fareKrw: 7000 },
      { ticketNumber: "issued4", seat: "04", fareKrw: 15000 },
    ],
  });
  expect(await fake.requests[0]?.json()).toMatchObject({ SET_NO: "01:02:03:04" });
});
for (const rows of [
  ticketRows.map((ticket) => (ticket.SET_NO === "3" ? { ...ticket, BTK_COD: "IU10" } : ticket)),
  ticketRows.slice(0, 3),
  [...ticketRows.slice(0, 3), ticketRows[0]],
  ticketRows.map((ticket) => (ticket.SET_NO === "3" ? { ...ticket, TCK_FEE: "8000" } : ticket)),
]) {
  test("keeps partial duplicate or incorrectly priced ticket groups unknown", async () => {
    // Given
    const fake = fixture((request) =>
      request.url.includes("selectBuyTckInfoList2")
        ? Response.json({ ERR_COD: "00000", TCK_LIST: rows })
        : reconcileResponse(request),
    );
    // When
    const result = await fake.purchase.reconcile(context, lookup);
    // Then
    expect(result).toEqual({ status: "unknown" });
    expect(fake.requests).toHaveLength(3);
  });
}
test("rejects aggregate history with an incomplete passenger count", async () => {
  // Given
  const fake = fixture((request) =>
    request.url.includes("inqrMbrsBusUtlzList")
      ? Response.json({
          rstCd: "200",
          dta: { busUtlzList: [{ ...identity, BMG_COD: "1", CNT: 1 }] },
        })
      : reconcileResponse(request),
  );
  // When
  const result = await fake.purchase.reconcile(context, lookup);
  // Then
  expect(result).toEqual({ status: "unknown" });
});
test("decodes legacy holds without allowing new purchase or release", async () => {
  // Given
  const legacy = {
    trip: {
      ...trip,
      expectedTotalFareKrw: undefined,
      passengers: undefined,
      fareQuotes: undefined,
    },
    info,
    seat: "02",
    holdId: "legacy",
    ticketKind: "IG00",
  } as const;
  const fake = fixture(reconcileResponse);
  // When
  const decoded = GoPurchaseHoldSchema.parse(legacy);
  // Then
  expect(decoded).toEqual(legacy);
  await expect(fake.purchase.prepare(context, decoded, "member")).rejects.toMatchObject({
    code: "unsupported",
  });
  await expect(fake.bus.release(context, decoded)).rejects.toMatchObject({ code: "input" });
  expect(fake.requests).toHaveLength(0);
});
