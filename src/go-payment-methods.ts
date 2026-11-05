import { z } from "zod";

const optionalText = z.string().nullish();
const menuSchema = z.object({ displayYn: optionalText });
const memberSchema = menuSchema.extend({ mbrsUseYn: optionalText });
const cardSchema = memberSchema.extend({ cardCpNm: optionalText, cardNum4th: optionalText });

export const GoPaymentResponseSchema = z.object({
  rstCd: z.union([z.literal("200"), z.literal(200)]),
  dta: z.object({
    npayautPymInfo: cardSchema.extend({ automaticPayId: optionalText }).nullish(),
    npayPymInfo: memberSchema.nullish(),
    smpcPymInfo: memberSchema
      .extend({
        dataCount: z.string().regex(/^\d+$/).nullish(),
        smpcPymList: z.array(menuSchema.extend({ paymentKey: optionalText })).nullish(),
      })
      .nullish(),
    tspyautPymInfo: cardSchema
      .extend({
        billingKey: optionalText,
        payMethod: optionalText,
        bankName: optionalText,
      })
      .nullish(),
    tspyPymInfo: menuSchema.nullish(),
    kbpyautPymInfo: cardSchema.extend({ paymentKey: optionalText }).nullish(),
    tmoneyPayInfo: memberSchema
      .extend({
        elwlProdList: z
          .array(
            z.object({
              elwlPrdCd: optionalText,
              ppyDpyDvsCd: optionalText,
              rtnAmt: optionalText,
              seqNo: optionalText,
              tmcrNo: optionalText,
            }),
          )
          .nullish(),
      })
      .nullish(),
    bizPayInfo: memberSchema.nullish(),
    otherPayInfo: z.object({ PAYCO: menuSchema.nullish() }).nullish(),
  }),
});

export type GoPaymentMethod =
  | "naver_pay_auto"
  | "naver_pay"
  | "registered_card"
  | "toss_pay_auto"
  | "toss_pay"
  | "kb_pay_auto"
  | "tmoney_pay"
  | "business_pay"
  | "payco";

export type GoPaymentMethodStatus = {
  readonly method: GoPaymentMethod;
  readonly registration: "registered" | "not_registered" | "unknown";
  readonly billingReferenceAvailable: boolean | null;
  readonly displayed: boolean | null;
};

export function canUseAutomaticNpay(methods: readonly GoPaymentMethodStatus[]): boolean {
  return methods.some(
    (method) =>
      method.method === "naver_pay_auto" &&
      method.registration === "registered" &&
      method.billingReferenceAvailable === true &&
      method.displayed !== false,
  );
}

type PaymentData = z.infer<typeof GoPaymentResponseSchema>["dta"];
type MemberInfo = z.infer<typeof memberSchema> | null | undefined;

function displayed(value: string | null | undefined): boolean | null {
  return value === "Y" ? true : value === "N" ? false : null;
}

function registration(info: MemberInfo): GoPaymentMethodStatus["registration"] {
  if (info === null || info?.mbrsUseYn === "N") return "not_registered";
  return info?.mbrsUseYn === "Y" ? "registered" : "unknown";
}

function billing(info: MemberInfo, key: string | null | undefined): boolean | null {
  if (info === null) return false;
  return key === undefined ? null : Boolean(key?.trim());
}

function methodStatus(
  method: GoPaymentMethod,
  info: MemberInfo,
  billingReferenceAvailable: boolean | null,
): GoPaymentMethodStatus {
  return {
    method,
    registration: registration(info),
    billingReferenceAvailable,
    displayed: displayed(info?.displayYn),
  };
}

export function summarizeGoPayments(data: PaymentData): {
  readonly naverPay: Omit<GoPaymentMethodStatus, "method">;
  readonly paymentMethods: readonly GoPaymentMethodStatus[];
} {
  const npay = data.npayautPymInfo;
  let naverRegistration = registration(npay);
  if (
    npay?.mbrsUseYn === undefined &&
    npay?.cardCpNm !== undefined &&
    npay.cardNum4th !== undefined
  ) {
    naverRegistration = npay.cardCpNm && npay.cardNum4th ? "registered" : "not_registered";
  }
  const naverPay = {
    registration: naverRegistration,
    billingReferenceAvailable: billing(npay, npay?.automaticPayId),
    displayed: displayed(data.npayPymInfo?.displayYn),
  };
  const cards = data.smpcPymInfo;
  const cardList = cards?.smpcPymList;
  const cardBilling =
    cards === null || cardList === null || cardList?.length === 0
      ? false
      : cardList?.some((card) => Boolean(card.paymentKey?.trim()))
        ? true
        : cardList?.every((card) => card.paymentKey !== undefined)
          ? false
          : null;
  let cardRegistration = registration(cards);
  if (cards?.mbrsUseYn === undefined && cardList !== undefined) {
    cardRegistration =
      cardList === null || cardList.length === 0
        ? "not_registered"
        : cardBilling === true
          ? "registered"
          : "unknown";
  }
  return {
    naverPay,
    paymentMethods: [
      { ...naverPay, method: "naver_pay_auto", displayed: displayed(npay?.displayYn) },
      methodStatus("naver_pay", data.npayPymInfo, null),
      { ...methodStatus("registered_card", cards, cardBilling), registration: cardRegistration },
      methodStatus(
        "toss_pay_auto",
        data.tspyautPymInfo,
        billing(data.tspyautPymInfo, data.tspyautPymInfo?.billingKey),
      ),
      {
        method: "toss_pay",
        registration: "unknown",
        billingReferenceAvailable: null,
        displayed: displayed(data.tspyPymInfo?.displayYn),
      },
      methodStatus(
        "kb_pay_auto",
        data.kbpyautPymInfo,
        billing(data.kbpyautPymInfo, data.kbpyautPymInfo?.paymentKey),
      ),
      methodStatus("tmoney_pay", data.tmoneyPayInfo, null),
      methodStatus("business_pay", data.bizPayInfo, null),
      {
        method: "payco",
        registration: "unknown",
        billingReferenceAvailable: null,
        displayed: displayed(data.otherPayInfo?.PAYCO?.displayYn),
      },
    ],
  };
}
