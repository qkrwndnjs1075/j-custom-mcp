import { expect, test } from "bun:test";
import type { GoBusHold } from "../src/go-bus-types";
import { context, fixture, hold } from "./go-purchase-fixtures";

const ticketIdentity = {
  ORD_SNO: "bus-order-distinct-from-payment",
  LIN_SNO: "line-1",
  USR_SNO: "bus-member",
  TIM_DTE: "20261030",
  TIM_TIM: "093000",
  TER_SFR: "001",
  TER_STO: "002",
  SET_NO: "1",
  BTK_COD: "IG00",
};
const historyEntry = {
  LIN_SNO: "line-1",
  USR_SNO: "bus-member",
  TIM_DTE: "20261030",
  TIM_TIM: "0930",
  BMG_COD: "1",
  CNT: 1,
};
const lookup = {
  hold,
  memberSerialNumber: "go-member",
  purchaseMonth: "202610",
  paymentOrderNumber: "order-1",
};
function ticketResponse(request: Request) {
  if (request.url.includes("selectTckRstStat"))
    return Response.json({
      ERR_COD: "00000",
      LIN_SNO: "line-1",
      ORD_SNO: "bus-order-distinct-from-payment",
    });
  if (request.url.includes("selectBuyTckInfo2"))
    return Response.json({ ERR_COD: "00000", ...ticketIdentity, ADM_AMT: "15000" });
  if (request.url.includes("selectBuyTckInfoList2"))
    return Response.json({
      ERR_COD: "00000",
      TCK_LIST: [{ ...ticketIdentity, TCK_FEE: "15000", TISU_ID: "issued-id" }],
    });
  return Response.json({ rstCd: "200", dta: { busUtlzList: [historyEntry] } });
}

test("confirms only when independent detail list and issued history agree", async () => {
  const fake = fixture(ticketResponse);
  const result = await fake.client.reconcile(context, lookup);
  expect(result).toEqual({
    status: "confirmed",
    orderNumber: "bus-order-distinct-from-payment",
    ticketNumber: "line-1",
    seat: "01",
    fareKrw: 15000,
    tickets: [{ ticketNumber: "issued-id", seat: "01", fareKrw: 15000 }],
  });
  expect(fake.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/tgx/tgoxzz/ticket/selectTckRstStat.do",
    "/tgx/tgoxzz/ticket/selectBuyTckInfo2.do",
    "/tgx/tgoxzz/ticket/selectBuyTckInfoList2.do",
    "/api/mbrs/v2/inqrMbrsBusUtlzList",
  ]);
});

test("confirms stable ticket identity when opaque owner echoes rotate and row order is absent", async () => {
  // Given
  const { ORD_SNO: _order, ...rowIdentity } = ticketIdentity;
  const fake = fixture((request) => {
    if (request.url.includes("selectBuyTckInfo2"))
      return Response.json({
        ERR_COD: "00000",
        ...ticketIdentity,
        USR_SNO: "opaque-detail-owner",
        ADM_AMT: "15000",
      });
    if (request.url.includes("selectBuyTckInfoList2"))
      return Response.json({
        ERR_COD: "00000",
        TCK_LIST: [
          {
            ...rowIdentity,
            USR_SNO: "opaque-row-owner",
            TCK_FEE: "15000",
            TISU_ID: "issued-id",
          },
        ],
      });
    if (request.url.includes("inqrMbrsBusUtlzList"))
      return Response.json({
        rstCd: "200",
        dta: { busUtlzList: [{ ...historyEntry, USR_SNO: "opaque-history-owner" }] },
      });
    return ticketResponse(request);
  });
  // When
  const result = await fake.client.reconcile(context, lookup);
  // Then
  expect(result).toMatchObject({
    status: "confirmed",
    orderNumber: ticketIdentity.ORD_SNO,
    ticketNumber: ticketIdentity.LIN_SNO,
    tickets: [{ ticketNumber: "issued-id", seat: "01", fareKrw: 15000 }],
  });
  expect(fake.requests).toHaveLength(4);
});

test.each([
  { ORD_SNO: "foreign-order" },
  { LIN_SNO: "foreign-line" },
  { TIM_DTE: "20261031" },
  { TIM_TIM: "103000" },
  { TER_SFR: "003" },
  { TER_STO: "004" },
  { SET_NO: "2" },
  { TCK_FEE: "14999" },
  { BTK_COD: "IC50" },
])(
  "rejects conflicting per-ticket identity despite an authenticated lookup: %j",
  async (change) => {
    // Given
    const fake = fixture((request) =>
      request.url.includes("selectBuyTckInfoList2")
        ? Response.json({
            ERR_COD: "00000",
            TCK_LIST: [{ ...ticketIdentity, TCK_FEE: "15000", TISU_ID: "issued-id", ...change }],
          })
        : ticketResponse(request),
    );
    // When
    const result = await fake.client.reconcile(context, lookup);
    // Then
    expect(result).toEqual({ status: "unknown" });
  },
);

test.each([undefined, "foreign-order"])(
  "requires the detail order to match status: %s",
  async (ORD_SNO) => {
    // Given
    const fake = fixture((request) =>
      request.url.includes("selectBuyTckInfo2")
        ? Response.json({ ERR_COD: "00000", ...ticketIdentity, ORD_SNO, ADM_AMT: "15000" })
        : ticketResponse(request),
    );
    // When
    const result = await fake.client.reconcile(context, lookup);
    // Then
    expect(result).toEqual({ status: "unknown" });
  },
);

test("queries the recorded purchase month and member serial after restart", async () => {
  const fake = fixture(ticketResponse);
  await fake.client.reconcile(context, { ...lookup, purchaseMonth: "202402" });
  expect(await fake.requests[1]?.json()).toMatchObject({
    MEM_SNO: "go-member",
    LIN_SNO: "line-1",
    USR_SNO: "bus-member",
  });
  expect(await fake.requests[3]?.json()).toEqual({
    inqrCtVal: "T",
    rideStatCd: "0",
    inqrSttDt: "20240201",
    inqrEndDt: "20240229",
    jrnyYn: "N",
    inqrMonth: "202402",
  });
});

for (const status of ["2", "4", "5", "unexpected"]) {
  test(`leaves outcome unknown when history status is ${status}`, async () => {
    const fake = fixture((request) =>
      request.url.includes("inqrMbrsBusUtlzList")
        ? Response.json({
            rstCd: "200",
            dta: { busUtlzList: [{ ...historyEntry, BMG_COD: status }] },
          })
        : ticketResponse(request),
    );
    expect(await fake.client.reconcile(context, lookup)).toEqual({ status: "unknown" });
    expect(fake.requests).toHaveLength(4);
  });
}

test("does not confirm a conflicting duplicate history record", async () => {
  const fake = fixture((request) =>
    request.url.includes("inqrMbrsBusUtlzList")
      ? Response.json({
          rstCd: "200",
          dta: { busUtlzList: [historyEntry, { ...historyEntry, BMG_COD: "4" }] },
        })
      : ticketResponse(request),
  );
  expect(await fake.client.reconcile(context, lookup)).toEqual({ status: "unknown" });
});

test("does not confirm a mismatched independently queried seat", async () => {
  const fake = fixture((request) =>
    request.url.includes("selectBuyTckInfoList2")
      ? Response.json({
          ERR_COD: "00000",
          TCK_LIST: [{ ...ticketIdentity, SET_NO: "2", TCK_FEE: "15000", TISU_ID: "issued-id" }],
        })
      : ticketResponse(request),
  );
  expect(await fake.client.reconcile(context, lookup)).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(3);
});

test("does not confirm a mismatched independently queried fare", async () => {
  const fake = fixture((request) =>
    request.url.includes("selectBuyTckInfo2")
      ? Response.json({ ERR_COD: "00000", ...ticketIdentity, ADM_AMT: "10000" })
      : ticketResponse(request),
  );
  expect(await fake.client.reconcile(context, lookup)).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(2);
});

test("reconciles a stored legacy single hold without allowing another purchase", async () => {
  // Given
  const legacy: GoBusHold = {
    trip: { ...hold.trip, expectedTotalFareKrw: undefined },
    info: hold.info,
    seat: "01",
    holdId: "synthetic-hold",
    ticketKind: "IG00",
  };
  const fake = fixture(ticketResponse);
  // When
  const result = await fake.client.reconcile(context, { ...lookup, hold: legacy });
  // Then
  expect(result).toEqual({
    status: "confirmed",
    orderNumber: "bus-order-distinct-from-payment",
    ticketNumber: "line-1",
    seat: "01",
    fareKrw: 15000,
  });
  await expect(fake.client.prepare(context, legacy, "go-member")).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(fake.requests).toHaveLength(4);
});
