import { expect, test } from "bun:test";
import { context, fixture, hold } from "./go-purchase-fixtures";

const lookup = { hold, memberSerialNumber: "go-member", purchaseMonth: "202610" };
const history = {
  LIN_SNO: "line-1",
  ORD_SNO: "bus-order",
  USR_SNO: "opaque-history-owner",
  TIM_DTE: "20261030",
  TIM_TIM: "0930",
  TER_SFR: "001",
  TER_STO: "002",
  BMG_COD: "1",
  ADM_KND_COD: "N",
  CNT: 1,
};
const detail = { ...history, USR_SNO: "opaque-detail-owner", ADM_AMT: 15000, SET_NO: "1" };
const ticket = {
  LIN_SNO: history.LIN_SNO,
  USR_SNO: "opaque-ticket-owner",
  TIM_DTE: history.TIM_DTE,
  TIM_TIM: history.TIM_TIM,
  TER_SFR: history.TER_SFR,
  TER_STO: history.TER_STO,
  SET_NO: "1",
  TCK_FEE: 15000,
  BTK_COD: "IG00",
  TISU_ID: "issued-id",
};
function response(request: Request): Response {
  if (request.url.includes("selectTckRstStat")) return Response.json({ ERR_COD: "M1001" });
  if (request.url.includes("selectMyPagePayList"))
    return Response.json({ ERR_COD: "00000", payList: [history] });
  if (request.url.includes("selectBuyTckInfo2"))
    return Response.json({ ERR_COD: "00000", ...detail });
  if (request.url.includes("selectBuyTckInfoList2"))
    return Response.json({ ERR_COD: "00000", tckList: [ticket] });
  return Response.json({ rstCd: "200", dta: { busUtlzList: [history] } });
}

test("recovers unknown status through a unique authenticated history and independent ticket checks", async () => {
  // Given
  const fake = fixture(response);
  // When
  const result = await fake.client.reconcile(context, lookup);
  // Then
  expect(result).toEqual({
    status: "confirmed",
    orderNumber: "bus-order",
    ticketNumber: "line-1",
    seat: "01",
    fareKrw: 15000,
    tickets: [{ ticketNumber: "issued-id", seat: "01", fareKrw: 15000 }],
  });
  expect(fake.requests.map((request) => new URL(request.url).pathname.split("/").at(-1))).toEqual([
    "selectTckRstStat.do",
    "selectMyPagePayList.do",
    "selectBuyTckInfo2.do",
    "selectBuyTckInfoList2.do",
    "inqrMbrsBusUtlzList",
  ]);
});

test.each([
  { payList: [] },
  { payList: [history, { ...history, LIN_SNO: "another-line" }] },
  { payList: [{ ...history, TER_SFR: "003" }] },
  { payList: [{ ...history, TIM_TIM: "1030" }] },
  { payList: [{ ...history, CNT: 2 }] },
  { payList: [{ ...history, BMG_COD: "4" }] },
  { payList: [{ ...history, ADM_KND_COD: "X" }] },
])("keeps ambiguous or mismatched recovery history unresolved: %j", async ({ payList }) => {
  // Given
  const fake = fixture((request) =>
    request.url.includes("selectMyPagePayList")
      ? Response.json({ ERR_COD: "00000", payList })
      : response(request),
  );
  // When
  const result = await fake.client.reconcile(context, lookup);
  // Then
  expect(result).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(2);
});

test.each([
  { ORD_SNO: "foreign-order" },
  { ORD_SNO: undefined },
  { SET_NO: "2" },
  { ADM_AMT: 14999 },
  { TER_STO: "003" },
])("rejects conflicting recovery detail: %j", async (change) => {
  // Given
  const fake = fixture((request) =>
    request.url.includes("selectBuyTckInfo2")
      ? Response.json({ ERR_COD: "00000", ...detail, ...change })
      : response(request),
  );
  // When
  const result = await fake.client.reconcile(context, lookup);
  // Then
  expect(result).toEqual({ status: "unknown" });
});

test("does not continue history recovery after an authentication failure", async () => {
  // Given
  const fake = fixture(() => new Response("unauthorized", { status: 401 }));
  // When
  const result = await fake.client.reconcile(context, lookup);
  // Then
  expect(result).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(1);
});
