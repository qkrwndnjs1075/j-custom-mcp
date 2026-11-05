import { afterEach, expect, test } from "bun:test";
import { GoPurchaseError } from "../src/go-purchase";
import { buildGoIssueBody } from "../src/go-purchase-types";
import {
  context as expressContext,
  fixture as expressFixture,
  hold as expressHold,
  response as expressResponse,
  stopFixtures,
} from "./go-express-fixtures";
import {
  basicResponse,
  context,
  fixture,
  hold,
  reservedFixture,
  secret,
} from "./go-purchase-fixtures";

afterEach(stopFixtures);

test.each(["intercity", "express"] as const)(
  "forwards an empty native authorization string privately for %s issuance",
  async (service) => {
    const response = (request: Request) =>
      request.url.includes("autoReserve")
        ? Response.json({
            rstCd: "200",
            dta: {
              rspCd: "0000",
              oderSno: "order-empty-auth",
              authDataCard: secret,
              authDataAuth: "",
            },
          })
        : service === "intercity"
          ? basicResponse(request)
          : expressResponse(request);
    const fake = service === "intercity" ? fixture(response) : expressFixture(response);
    const client = "client" in fake ? fake.client : fake.purchase;
    const selectedContext = service === "intercity" ? context : expressContext;
    const selectedHold = service === "intercity" ? hold : expressHold;
    const prepared = await client.prepare(selectedContext, selectedHold, "go-member");
    const reservation = await client.reserve(selectedContext, prepared);
    expect(JSON.stringify([prepared, reservation])).toBe('[{},{"orderNumber":"order-empty-auth"}]');
    expect(Bun.inspect([prepared, reservation])).not.toContain(secret);
    await client.issue(selectedContext, selectedHold, reservation);
    const issue = await fake.requests[2]?.json();
    expect(issue).toMatchObject(
      service === "intercity"
        ? { BILL_AUTH_DATA: { card: secret, auth: "" }, ODER_SNO: "order-empty-auth" }
        : { bill_auth_data: { card: secret, auth: "" }, oder_sno: "order-empty-auth" },
    );
    await expect(client.issue(selectedContext, selectedHold, reservation)).rejects.toMatchObject({
      code: "configuration",
    });
    expect(fake.requests).toHaveLength(3);
  },
);

test.each([
  { authDataAuth: undefined },
  { authDataAuth: null },
  { authDataAuth: 1 },
  { authDataAuth: {} },
  { authDataAuth: "x".repeat(16385) },
  { authDataCard: "" },
  { oderSno: "" },
  { rspCd: "E123" },
])("rejects invalid required reserve fields even when auth may be empty", async (invalid) => {
  const fake = fixture((request) =>
    request.url.includes("autoReserve")
      ? Response.json({
          rstCd: "200",
          dta: {
            rspCd: "0000",
            oderSno: "order-empty-auth",
            authDataCard: secret,
            authDataAuth: "",
            ...invalid,
          },
        })
      : basicResponse(request),
  );
  const prepared = await fake.client.prepare(context, hold, "go-member");
  const error: unknown = await fake.client
    .reserve(context, prepared)
    .catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "reserve_uncertain" });
  expect(`${JSON.stringify(error)} ${Bun.inspect(error)}`).not.toContain(secret);
  await expect(fake.client.reserve(context, prepared)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(fake.requests).toHaveLength(2);
});

test("checks availability without returning a billing reference or reserving payment", async () => {
  const fake = fixture(basicResponse);

  const result = await fake.client.checkAvailability(context, "intercity");

  expect(result).toBeUndefined();
  expect(fake.requests.map((request) => request.url)).toEqual([
    "https://tiaapi.tmoney.co.kr:20328/api/pym/v2/inqrPymMnsListAtPym",
  ]);
});

test.each([401, 403, 500])(
  "sanitizes preflight HTTP %i as payment unavailable without retrying",
  async (status) => {
    const fake = fixture(() => new Response(secret, { status }));

    const error: unknown = await fake.client.checkAvailability(context, "intercity").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(GoPurchaseError);
    if (!(error instanceof GoPurchaseError))
      throw new TypeError("Expected sanitized purchase error");
    expect(error.code).toBe("payment_unavailable");
    expect(error.cause).toBeUndefined();
    expect(`${JSON.stringify(error)} ${Bun.inspect(error)}`).not.toContain(secret);
    expect(fake.requests).toHaveLength(1);
  },
);

test("keeps payment credentials opaque when a registered method is prepared and reserved", async () => {
  const fake = await reservedFixture();
  expect(JSON.stringify([fake.prepared, fake.reservation])).toBe('[{},{"orderNumber":"order-1"}]');
  expect(Bun.inspect([fake.prepared, fake.reservation])).not.toContain(secret);
});

test("sends only recovered autoReserve fields with distinct GO member serial when reserving", async () => {
  const fake = await reservedFixture();
  const request = fake.requests[1];
  expect(request?.url).toBe("https://tiaapi.tmoney.co.kr:20328/api/pym/npay/v1/autoReserve");
  expect(await request?.json()).toEqual({
    moappMbrsSno: "go-member",
    automaticPayId: secret,
    utlzSvcDvsCd: "C",
    productCount: 1,
    productName: "(티머니GO)시외버스 승차권",
    productAmount: 15000,
  });
});

test("consumes preparation once when automatic reservation is repeated", async () => {
  const fake = await reservedFixture();
  await expect(fake.client.reserve(context, fake.prepared)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(fake.requests).toHaveLength(2);
});

test("uses nested authorization and exact held seat when issuing once", async () => {
  const fake = await reservedFixture();
  await fake.client.issue(context, hold, fake.reservation);
  const request = fake.requests[2];
  expect(request?.url).toBe("https://icbusmob.tmoney.co.kr/tgx/tgoxzz/ticket/insertTckCad_CR.do");
  expect(await request?.json()).toMatchObject({
    BILL_AUTH_DATA: { card: secret, auth: secret },
    ODER_SNO: "order-1",
    CST_COD: "00",
    SATS_PCPY_ID: "synthetic-hold",
    SET_NO_WEB: "01",
    TCK_FEE1: "15000",
    CNT_100: "1",
    TISSU_MNS_CD: "GA11",
  });
});

test("does not submit again when an issuance handle is reused", async () => {
  const fake = await reservedFixture();
  await fake.client.issue(context, hold, fake.reservation);
  await expect(fake.client.issue(context, hold, fake.reservation)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(fake.requests).toHaveLength(3);
});

test("returns uncertainty without retry or secret exposure when issuance HTTP fails", async () => {
  const fake = await reservedFixture((request) =>
    request.url.includes("insertTck")
      ? new Response(secret, { status: 503 })
      : basicResponse(request),
  );
  const result: unknown = await fake.client
    .issue(context, hold, fake.reservation)
    .catch((error: unknown) => error);
  expect(result).toBeInstanceOf(GoPurchaseError);
  expect(result).toMatchObject({ code: "purchase_uncertain" });
  expect(Bun.inspect(result)).not.toContain(secret);
  expect(fake.requests).toHaveLength(3);
});

test("rejects changed fare before payment inquiry", async () => {
  const fake = fixture(basicResponse);
  await expect(
    fake.client.prepare(
      context,
      { ...hold, info: { ...hold.info, tckfee1: "16000" } },
      "go-member",
    ),
  ).rejects.toMatchObject({ code: "unsupported" });
  expect(fake.requests).toHaveLength(0);
});

test("rejects the missing registered payment method before reserving", async () => {
  const fake = fixture(() => Response.json({ rstCd: "200", dta: { npayautPymInfo: null } }));
  await expect(fake.client.prepare(context, hold, "go-member")).rejects.toMatchObject({
    code: "payment_unavailable",
  });
  expect(fake.requests).toHaveLength(1);
});

test("omits unused student fare type for an adult-only purchase", () => {
  expect(
    buildGoIssueBody({ ...hold, info: { ...hold.info, tckfee93: "7000" } }).FEE9_TYPE,
  ).toBeUndefined();
});

test("consumes preparation without retry when reservation response is malformed", async () => {
  const fake = fixture((request) =>
    request.url.includes("autoReserve")
      ? Response.json({ rstCd: "200", dta: { rspCd: "0000", authDataCard: secret } })
      : basicResponse(request),
  );
  const prepared = await fake.client.prepare(context, hold, "go-member");
  await expect(fake.client.reserve(context, prepared)).rejects.toMatchObject({
    code: "reserve_uncertain",
  });
  await expect(fake.client.reserve(context, prepared)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(fake.requests).toHaveLength(2);
});

test("rejects a substituted seat before issuance while preserving original handle", async () => {
  const fake = await reservedFixture();
  await expect(
    fake.client.issue(
      context,
      {
        ...hold,
        seats: [
          { seat: "02", holdId: "synthetic-hold", ticketKind: "IG00", passengerType: "adult" },
        ],
      },
      fake.reservation,
    ),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(fake.requests).toHaveLength(2);
  await fake.client.issue(context, hold, fake.reservation);
  expect(fake.requests).toHaveLength(3);
});

test("keeps business unknown outcome unresolved without issuing another ticket", async () => {
  const fake = fixture(() => Response.json({ ERR_COD: "M1001" }));
  expect(
    await fake.client.reconcile(context, {
      hold,
      memberSerialNumber: "go-member",
      purchaseMonth: "202610",
    }),
  ).toEqual({
    status: "unknown",
  });
  expect(fake.requests.map((request) => new URL(request.url).pathname)).toEqual([
    "/tgx/tgoxzz/ticket/selectTckRstStat.do",
    "/tgx/tgoxzz/user/selectMyPagePayList.do",
  ]);
});
