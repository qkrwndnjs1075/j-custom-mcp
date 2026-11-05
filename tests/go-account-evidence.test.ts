import { describe, expect, test } from "bun:test";
import { fixture, registered, secret, session } from "./go-account-fixtures";

describe("GO account inquiry with synthetic HTTP fixtures", () => {
  test("preserves unknown evidence for every omitted method", async () => {
    const fake = fixture(() => Response.json({ rstCd: 200, dta: {} }));

    const result = await fake.client.readPaymentStatus(session, "intercity");

    expect(result.paymentMethods).toHaveLength(9);
    for (const method of result.paymentMethods) {
      expect(method).toEqual({
        method: method.method,
        registration: "unknown",
        billingReferenceAvailable: null,
        displayed: null,
      });
    }
  });

  test.each([
    ["npayautPymInfo", "naver_pay_auto"],
    ["smpcPymInfo", "registered_card"],
    ["tspyautPymInfo", "toss_pay_auto"],
    ["kbpyautPymInfo", "kb_pay_auto"],
    ["tmoneyPayInfo", "tmoney_pay"],
    ["bizPayInfo", "business_pay"],
  ] as const)("reports absent registration when %s is explicitly null", async (field, method) => {
    const fake = fixture(() => Response.json({ rstCd: 200, dta: { [field]: null } }));

    const result = await fake.client.readPaymentStatus(session, "intercity");

    expect(result.paymentMethods.find((item) => item.method === method)?.registration).toBe(
      "not_registered",
    );
  });

  test.each([
    ["npayautPymInfo", "naver_pay_auto", registered],
    ["smpcPymInfo", "registered_card", { smpcPymList: [{ paymentKey: secret }] }],
    ["tspyautPymInfo", "toss_pay_auto", { billingKey: secret, payMethod: "BANK" }],
    ["kbpyautPymInfo", "kb_pay_auto", { paymentKey: secret }],
  ] as const)(
    "does not infer registration from a stale key when %s denies member use",
    async (field, method, info) => {
      const fake = fixture(() =>
        Response.json({
          rstCd: 200,
          dta: { [field]: { ...info, mbrsUseYn: "N", displayYn: "Y" } },
        }),
      );

      const result = await fake.client.readPaymentStatus(session, "intercity");

      expect(result.paymentMethods.find((item) => item.method === method)).toEqual({
        method,
        registration: "not_registered",
        billingReferenceAvailable: true,
        displayed: true,
      });
      if (method === "naver_pay_auto") expect(result.naverPay.registration).toBe("not_registered");
    },
  );

  test.each([
    [{}, "unknown", null],
    [{ smpcPymList: [] }, "not_registered", false],
    [{ smpcPymList: null }, "not_registered", false],
    [{ smpcPymList: [{}] }, "unknown", null],
    [{ smpcPymList: [{ paymentKey: null }, { paymentKey: "" }] }, "unknown", false],
    [{ smpcPymList: [{ paymentKey: secret }] }, "registered", true],
    [{ mbrsUseYn: "unexpected", smpcPymList: [{ paymentKey: secret }] }, "unknown", true],
  ] as const)(
    "keeps saved-card evidence distinct when the response is partial: %j",
    async (info, registration, billingReferenceAvailable) => {
      const fake = fixture(() => Response.json({ rstCd: 200, dta: { smpcPymInfo: info } }));

      const result = await fake.client.readPaymentStatus(session, "intercity");

      expect(result.paymentMethods.find((item) => item.method === "registered_card")).toEqual({
        method: "registered_card",
        registration,
        billingReferenceAvailable,
        displayed: null,
      });
    },
  );
});
