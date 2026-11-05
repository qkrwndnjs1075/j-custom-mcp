import { describe, expect, test } from "bun:test";
import { fixture, registered, secret, session } from "./go-account-fixtures";

describe("GO account inquiry with synthetic HTTP fixtures", () => {
  test("sends the recovered route, headers and service body when given a session", async () => {
    // Given
    let body: unknown;
    const fake = fixture(async (request) => {
      body = await request.json();
      return Response.json({ rstCd: "200", dta: {} });
    });
    // When
    await fake.client.readPaymentStatus(session, "intercity");
    // Then
    expect(fake.providerUrls).toEqual([
      "https://tiaapi.tmoney.co.kr:20328/api/pym/v2/inqrPymMnsListAtPym",
    ]);
    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    if (!request) throw new TypeError("Expected one HTTP request");
    expect(request.method).toBe("POST");
    expect(body).toEqual({ utlzSvcDvsCd: "C" });
    expect(
      Object.fromEntries(
        ["authorization", "appcode", "uuid", "appver", "osknd", "osver"].map((key) => [
          key,
          request.headers.get(key),
        ]),
      ),
    ).toEqual({
      authorization: `Bearer ${secret}`,
      appcode: session.appCode,
      uuid: session.uuid,
      appver: session.appVer,
      osknd: session.osKnd,
      osver: session.osVer,
    });
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("cookie")).toBeNull();
  });

  test.each(["200", 200])(
    "returns only status when the outer success code is %s",
    async (rstCd) => {
      // Given
      const fake = fixture(() =>
        Response.json({
          rstCd,
          secret,
          dta: {
            respCd: "uninterpreted",
            npayautPymInfo: registered,
            npayPymInfo: { displayYn: "Y" },
          },
        }),
      );
      // When
      const result = await fake.client.readPaymentStatus(session, "intercity");
      // Then
      expect(result).toMatchObject({
        connection: "connected",
        naverPay: {
          registration: "registered",
          billingReferenceAvailable: true,
          displayed: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(fake.client)).toBe("{}");
    },
  );

  test.each([
    [undefined, "unknown", null],
    [null, "not_registered", false],
    [{}, "unknown", null],
    [{ cardCpNm: "Card" }, "unknown", null],
    [{ cardNum4th: "9999" }, "unknown", null],
    [{ cardCpNm: null, cardNum4th: "9999", automaticPayId: null }, "not_registered", false],
    [{ cardCpNm: "Card", cardNum4th: "", automaticPayId: "" }, "not_registered", false],
    [{ cardCpNm: "", cardNum4th: "9999" }, "not_registered", null],
    [{ cardCpNm: "Card", cardNum4th: "9999" }, "registered", null],
  ] as const)(
    "preserves registration evidence when automatic info is %j",
    async (info, registration, billing) => {
      // Given
      const fake = fixture(() => Response.json({ rstCd: 200, dta: { npayautPymInfo: info } }));
      // When
      const result = await fake.client.readPaymentStatus(session, "intercity");
      // Then
      expect(result.naverPay).toEqual({
        registration,
        billingReferenceAvailable: billing,
        displayed: null,
      });
    },
  );

  test("discovers registered methods and menu-only methods without disclosing payment data", async () => {
    const fake = fixture(() =>
      Response.json({
        rstCd: 200,
        dta: {
          npayautPymInfo: registered,
          npayPymInfo: { displayYn: "Y" },
          smpcPymInfo: {
            mbrsUseYn: "Y",
            displayYn: "Y",
            dataCount: "2",
            smpcPymList: [
              {
                paymentKey: "private-card-key-one",
                cardName: "private-card-name",
                maskCardNo: "private-card-number",
                displayYn: "Y",
              },
              { paymentKey: "private-card-key-two", displayYn: "N" },
            ],
          },
          tspyautPymInfo: {
            mbrsUseYn: "Y",
            displayYn: "N",
            billingKey: "private-bank-billing",
            payMethod: "BANK",
            bankName: "private-bank-name",
          },
          tspyPymInfo: { displayYn: "Y" },
          kbpyautPymInfo: { mbrsUseYn: "Y", displayYn: "Y", paymentKey: "private-kb-key" },
          tmoneyPayInfo: {
            mbrsUseYn: "Y",
            displayYn: "Y",
            elwlProdList: [{ tmcrNo: "private-tmoney-card" }],
          },
          bizPayInfo: { mbrsUseYn: "N", displayYn: "Y" },
          otherPayInfo: { PAYCO: { displayYn: "Y" } },
          authToken: "private-auth-token",
        },
      }),
    );

    const result = await fake.client.readPaymentStatus(session, "intercity");

    expect(result.paymentMethods).toEqual([
      {
        method: "naver_pay_auto",
        registration: "registered",
        billingReferenceAvailable: true,
        displayed: false,
      },
      {
        method: "naver_pay",
        registration: "unknown",
        billingReferenceAvailable: null,
        displayed: true,
      },
      {
        method: "registered_card",
        registration: "registered",
        billingReferenceAvailable: true,
        displayed: true,
      },
      {
        method: "toss_pay_auto",
        registration: "registered",
        billingReferenceAvailable: true,
        displayed: false,
      },
      {
        method: "toss_pay",
        registration: "unknown",
        billingReferenceAvailable: null,
        displayed: true,
      },
      {
        method: "kb_pay_auto",
        registration: "registered",
        billingReferenceAvailable: true,
        displayed: true,
      },
      {
        method: "tmoney_pay",
        registration: "registered",
        billingReferenceAvailable: null,
        displayed: true,
      },
      {
        method: "business_pay",
        registration: "not_registered",
        billingReferenceAvailable: null,
        displayed: true,
      },
      {
        method: "payco",
        registration: "unknown",
        billingReferenceAvailable: null,
        displayed: true,
      },
    ]);
    expect(JSON.stringify(result)).not.toMatch(/private-|synthetic-secret|9999/);
  });
});
