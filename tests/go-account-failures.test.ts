import { describe, expect, test } from "bun:test";
import { GoAccountError, TmoneyGoAccountClient } from "../src/go-account";
import { expectFailure, fixture, secret, session } from "./go-account-fixtures";

describe("GO account inquiry with synthetic HTTP fixtures", () => {
  test.each([
    { tspyautPymInfo: { billingKey: { secret } } },
    { tspyautPymInfo: { payMethod: 42 } },
    { kbpyautPymInfo: { paymentKey: [secret] } },
    { smpcPymInfo: { smpcPymList: [{ paymentKey: { secret } }] } },
    { smpcPymInfo: { dataCount: "not-a-count" } },
    { tmoneyPayInfo: { elwlProdList: secret } },
    { tmoneyPayInfo: { mbrsUseYn: true } },
    { bizPayInfo: { displayYn: 1 } },
    { otherPayInfo: { PAYCO: { displayYn: { secret } } } },
  ])("sanitizes malformed discovery fields without retrying: %j", async (dta) => {
    const fake = fixture(() => Response.json({ rstCd: 200, dta }));

    const operation = fake.client.readPaymentStatus(session, "intercity");

    await expectFailure(operation, "response");
    expect(fake.requests).toHaveLength(1);
  });

  test.each([
    [undefined, null],
    [null, null],
    ["", null],
    ["unexpected", null],
    ["N", false],
  ])("preserves unknown display flags when displayYn is %j", async (displayYn, displayed) => {
    // Given
    const fake = fixture(() => Response.json({ rstCd: 200, dta: { npayPymInfo: { displayYn } } }));
    // When
    const result = await fake.client.readPaymentStatus(session, "intercity");
    // Then
    expect(result.naverPay.displayed).toBe(displayed);
  });

  test.each([401, 403, 500, 429])("sanitizes HTTP %i without retrying", async (status) => {
    // Given
    const fake = fixture(() => new Response(secret, { status }));
    // When
    const operation = fake.client.readPaymentStatus(session, "intercity");
    // Then
    await expectFailure(
      operation,
      status === 401 || status === 403 ? "authentication_required" : "http",
    );
    expect(fake.requests).toHaveLength(1);
  });

  test.each([
    { rstCd: "401", message: secret, dta: {} },
    { rstCd: "200" },
    { rstCd: 200, dta: null },
    { rstCd: 200, dta: { npayautPymInfo: { automaticPayId: { secret } } } },
    { rstCd: 200, dta: { npayautPymInfo: { cardCpNm: 1 } } },
  ])("rejects malformed or logical failure responses: %j", async (body) => {
    // Given
    const fake = fixture(() => Response.json(body));
    // When
    const operation = fake.client.readPaymentStatus(session, "intercity");
    // Then
    await expectFailure(operation, "response");
  });

  test("sanitizes malformed JSON when the response contains sensitive text", async () => {
    // Given
    const fake = fixture(() => new Response(secret));
    // When
    const operation = fake.client.readPaymentStatus(session, "intercity");
    // Then
    await expectFailure(operation, "response");
  });

  test("does not follow redirects when the provider redirects", async () => {
    // Given
    const fake = fixture(
      (request) =>
        new Response(secret, {
          status: 302,
          headers: { location: new URL("/redirect-target", request.url).href },
        }),
    );
    // When
    const operation = fake.client.readPaymentStatus(session, "intercity");
    // Then
    await expectFailure(operation, "network");
    expect(fake.requests).toHaveLength(1);
  });

  test.each(["headers", "body"])("times out stalled %s without retrying", async (stage) => {
    // Given
    const fake = fixture(
      () =>
        stage === "headers"
          ? new Promise<Response>(() => {})
          : new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("{"));
                },
              }),
            ),
      50,
    );
    // When
    const operation = fake.client.readPaymentStatus(session, "intercity");
    // Then
    await expectFailure(operation, "timeout");
    expect(fake.requests).toHaveLength(1);
  });

  test("sanitizes unexpected transport failures containing credentials", async () => {
    // Given
    const transport = Object.assign(
      async () => {
        throw new TypeError(secret);
      },
      { preconnect: fetch.preconnect },
    );
    const client = new TmoneyGoAccountClient({ fetch: transport });
    // When
    const operation = client.readPaymentStatus(session, "intercity");
    // Then
    await expectFailure(operation, "network");
  });

  test.each(["", `${secret}\r\nInjected: true`, `${secret}\u007f`, " leading", "trailing "])(
    "rejects unusable session headers before sending HTTP: %j",
    async (token) => {
      // Given
      const fake = fixture(() => Response.json({ rstCd: 200, dta: {} }));
      // When
      const operation = fake.client.readPaymentStatus({ ...session, token }, "intercity");
      // Then
      await expectFailure(operation, "configuration");
      expect(fake.requests).toHaveLength(0);
    },
  );

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects invalid timeout configuration: %s",
    (timeoutMs) => {
      // Given / When / Then
      expect(() => new TmoneyGoAccountClient({ timeoutMs })).toThrow(GoAccountError);
    },
  );
});
