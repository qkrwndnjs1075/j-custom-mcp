import { afterEach, expect, test } from "bun:test";
import { buildGoExpressIssueBody } from "../src/go-express-issue";
import { GoPurchaseError } from "../src/go-purchase";
import {
  context,
  fixture,
  hold,
  identity,
  lookup,
  response,
  secret,
  stopFixtures,
  tickets,
} from "./go-express-fixtures";
import { held as intercityHold } from "./go-passenger-fixtures";

afterEach(stopFixtures);
async function reservedFixture(handler = response) {
  const fake = fixture(handler);
  const prepared = await fake.purchase.prepare(context, hold, "express-member");
  const reservation = await fake.purchase.reserve(context, prepared);
  return { ...fake, prepared, reservation };
}

test("checks express H payment independently of intercity C availability", async () => {
  // Given
  const fake = fixture();
  // When
  await fake.purchase.checkAvailability(context, "express");
  await fake.purchase.checkAvailability(context, "intercity");
  // Then
  expect(await fake.requests[0]?.json()).toEqual({ utlzSvcDvsCd: "H" });
  expect(await fake.requests[1]?.json()).toEqual({ utlzSvcDvsCd: "C" });
});
test("reserves exact express passenger total and keeps billing authorization opaque", async () => {
  // Given
  const fake = fixture();
  const prepared = await fake.purchase.prepare(context, hold, "express-member");
  // When
  const reservation = await fake.purchase.reserve(context, prepared);
  // Then
  expect(await fake.requests[0]?.json()).toEqual({ utlzSvcDvsCd: "H" });
  expect(await fake.requests[1]?.json()).toEqual({
    automaticPayId: secret,
    moappMbrsSno: "express-member",
    utlzSvcDvsCd: "H",
    productName: "(티머니GO)고속버스 승차권",
    productCount: 3,
    productAmount: 34500,
  });
  expect(JSON.stringify([prepared, reservation])).toBe('[{},{"orderNumber":"payment-order"}]');
  expect(Bun.inspect([prepared, reservation])).not.toContain(secret);
});
test("issues express once using lowercase fields and recovered native passenger codes", async () => {
  // Given
  const fake = await reservedFixture();
  // When
  await fake.purchase.issue(context, hold, fake.reservation);
  // Then
  expect(fake.requests[2]?.url).toBe(
    "https://exp.tmoney.co.kr/tgm/tgoapp/k5/ticket/insertTckCad_CR.do",
  );
  expect(await fake.requests[2]?.json()).toEqual({
    ...buildGoExpressIssueBody(hold),
    bill_auth_data: { card: secret, auth: secret },
    oder_sno: "payment-order",
    cst_cod: "00",
    cur_ver: "1729",
    hp_cod: "A",
    ip_address: "",
    usr_sno: context.userNumber,
    os_ver: "34",
  });
  expect(buildGoExpressIssueBody(hold)).toMatchObject({
    tot_amt: "34500",
    cnt_100: "1",
    cnt_050: "1",
    amt_100: "1",
    amt_050: "0",
    usr_id: "0123456789",
    tissu_mns_cd: "GA11",
    lin_end1: "120",
    set_no_web: "01:03:04",
    pcpy_no: "express-h1:express-h3:express-h4",
  });
});
test("rejects a wrong service hold before consuming express issuance authority", async () => {
  // Given
  const fake = await reservedFixture();
  // When
  const action = fake.purchase.issue(context, intercityHold, fake.reservation);
  // Then
  await expect(action).rejects.toMatchObject({ code: "configuration" });
  expect(fake.requests).toHaveLength(2);
});
test("rejects wrong account before consuming express issuance authority", async () => {
  // Given
  const fake = await reservedFixture();
  // When
  const action = fake.purchase.issue(
    { ...context, userNumber: "foreign-user" },
    hold,
    fake.reservation,
  );
  // Then
  await expect(action).rejects.toMatchObject({ code: "configuration" });
  expect(fake.requests).toHaveLength(2);
});
test("returns redacted uncertainty and consumes issuance handle after express HTTP failure", async () => {
  // Given
  const fake = await reservedFixture((request) =>
    request.url.endsWith("insertTckCad_CR.do")
      ? new Response(secret, { status: 503 })
      : response(request),
  );
  // When
  const error: unknown = await fake.purchase
    .issue(context, hold, fake.reservation)
    .catch((error: unknown) => error);
  // Then
  expect(error).toBeInstanceOf(GoPurchaseError);
  expect(error).toMatchObject({ code: "purchase_uncertain" });
  expect(`${JSON.stringify(error)} ${Bun.inspect(error)}`).not.toContain(secret);
  await expect(fake.purchase.issue(context, hold, fake.reservation)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(fake.requests).toHaveLength(3);
});
test("preserves reserve uncertainty without retrying express payment", async () => {
  // Given
  const fake = fixture((request) =>
    request.url.endsWith("autoReserve")
      ? Response.json({ rstCd: "200", dta: null })
      : response(request),
  );
  const prepared = await fake.purchase.prepare(context, hold, "express-member");
  // When
  const action = fake.purchase.reserve(context, prepared);
  // Then
  await expect(action).rejects.toMatchObject({ code: "reserve_uncertain" });
  await expect(fake.purchase.reserve(context, prepared)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(fake.requests).toHaveLength(2);
});
test("confirms express receipt only after independent result, detail, seat list and active list agree", async () => {
  // Given
  const fake = fixture();
  // When
  const result = await fake.purchase.reconcile(context, lookup);
  // Then
  expect(result).toEqual({
    status: "confirmed",
    orderNumber: "express-order",
    ticketNumber: "express-line",
    seat: "01:03:04",
    fareKrw: 34500,
    tickets: tickets.map((ticket) => ({
      ticketNumber: ticket.TISU_ID,
      seat: ticket.SET_NO,
      fareKrw: Number(ticket.TCK_FEE),
    })),
  });
  expect(fake.requests.map((request) => new URL(request.url).pathname)).toEqual(
    ["selectTckRstStat", "selectBuyTckInfo2", "selectBuyTckInfoList2", "selectBuyTckListSecu"].map(
      (name) => `/tgm/tgoapp/k5/ticket/${name}.do`,
    ),
  );
  expect(await fake.requests[0]?.json()).toMatchObject({
    tim_tim_i: "1400",
    set_no: "01:03:04",
    usr_sno: context.userNumber,
  });
  expect(await fake.requests[3]?.json()).toMatchObject({
    mem_sno: "express-member",
    hp_syn_yn: "N",
    arpr_trml_yn: "N",
  });
});
for (const patch of [
  { ORD_SNO: "foreign" },
  { USR_SNO: "foreign" },
  { SET_NO: "1,3,5" },
  { ADM_AMT: "34000" },
  { BMG_COD: "4" },
  { TIM_DTE: "20261031" },
  { TER_SFR: "020" },
  { TER_FR: "000" },
  { TER_TO: "000" },
  { COR_COD: "00" },
  { BD_COD: "9" },
  { TIM_TIM_I: "1300" },
]) {
  test(`keeps express receipt unknown for mismatched detail ${Object.keys(patch)[0]}`, async () => {
    // Given
    const fake = fixture((request) =>
      request.url.endsWith("selectBuyTckInfo2.do")
        ? Response.json({
            errCode: "00000",
            ...identity,
            BMG_COD: "1",
            SET_NO: "1,3,4",
            ADM_AMT: "34500",
            ...patch,
          })
        : response(request),
    );
    // When
    const result = await fake.purchase.reconcile(context, lookup);
    // Then
    expect(result).toEqual({ status: "unknown" });
    expect(fake.requests).toHaveLength(2);
  });
}
for (const scenario of [
  "wrong fare",
  "wrong kind",
  "duplicate seat",
  "duplicate ticket",
  "missing seat",
] as const) {
  test(`keeps express receipt unknown when independent seat list has ${scenario}`, async () => {
    // Given
    const list = tickets.map((ticket, index) =>
      index === 0
        ? {
            ...ticket,
            ...(scenario === "wrong fare" ? { TCK_FEE: "7501" } : {}),
            ...(scenario === "wrong kind" ? { TCK_KND_COD: "1" } : {}),
            ...(scenario === "duplicate seat" ? { SET_NO: "03" } : {}),
            ...(scenario === "duplicate ticket" ? { TISU_ID: "ticket-03" } : {}),
          }
        : ticket,
    );
    if (scenario === "missing seat") list.pop();
    const fake = fixture((request) =>
      request.url.endsWith("selectBuyTckInfoList2.do")
        ? Response.json({ errCode: "00000", tckList: list })
        : response(request),
    );
    // When
    const result = await fake.purchase.reconcile(context, lookup);
    // Then
    expect(result).toEqual({ status: "unknown" });
    expect(fake.requests).toHaveLength(3);
  });
}
test("keeps express receipt unknown when independent active list does not contain the ticket", async () => {
  // Given
  const fake = fixture((request) =>
    request.url.endsWith("selectBuyTckListSecu.do")
      ? Response.json({ errCode: "00000", ticketList: [] })
      : response(request),
  );
  // When
  const result = await fake.purchase.reconcile(context, lookup);
  // Then
  expect(result).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(4);
});
test("does not issue again when express result inquiry reports M1001", async () => {
  // Given
  const fake = fixture(() => Response.json({ errCode: "M1001" }));
  // When
  const result = await fake.purchase.reconcile(context, lookup);
  // Then
  expect(result).toEqual({ status: "unknown" });
  expect(fake.requests).toHaveLength(1);
});
