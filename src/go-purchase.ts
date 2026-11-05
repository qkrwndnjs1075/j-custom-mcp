import { z } from "zod";
import type { BusService } from "./bus-service";
import { captureGoExpressReceiptBaseline } from "./go-express-baseline";

export { GO_PURCHASE_CAPABILITIES } from "./go-bus-fares";

import { GoBusHttp } from "./go-bus-http";
import { type GoBusContext, GoBusError, type GoBusHold } from "./go-bus-types";
import { buildGoExpressIssueBody } from "./go-express-issue";
import { GoExpressReconciler } from "./go-express-reconcile";
import {
  canUseAutomaticNpay,
  GoPaymentResponseSchema,
  summarizeGoPayments,
} from "./go-payment-methods";
import { GoPurchaseHttp } from "./go-purchase-http";
import { GoPurchaseReconciler } from "./go-purchase-reconcile";
import {
  buildGoIssueBody,
  GO_PURCHASE_TEXT_MAX_LENGTH,
  GoPurchaseError,
  type GoPurchaseLookup,
  type GoPurchaseOutcome,
  reserveFailureDiagnostic,
} from "./go-purchase-types";

export {
  GoPurchaseError,
  type GoPurchaseLookup,
  type GoPurchaseOutcome,
} from "./go-purchase-types";

const text = z.string().min(1).max(GO_PURCHASE_TEXT_MAX_LENGTH);
const paymentServices = {
  intercity: {
    code: "C",
    product: "(티머니GO)시외버스 승차권",
    auth: "BILL_AUTH_DATA",
    order: "ODER_SNO",
    customer: "CST_COD",
  },
  express: {
    code: "H",
    product: "(티머니GO)고속버스 승차권",
    auth: "bill_auth_data",
    order: "oder_sno",
    customer: "cst_cod",
  },
} as const;
const reserveSchema = z.object({
  rstCd: z.union([z.literal("200"), z.literal(200)]),
  dta: z.object({
    rspCd: z.literal("0000"),
    oderSno: text,
    authDataCard: text,
    authDataAuth: z.string().max(GO_PURCHASE_TEXT_MAX_LENGTH),
  }),
});
/** Opaque, process-local handles deliberately have no enumerable payment credentials. */
export class GoPaymentPreparation {}
export class GoPaymentReservation {
  constructor(readonly orderNumber: string) {}
}

type Preparation = {
  readonly service: "intercity" | "express";
  readonly automaticPayId: string;
  readonly memberSerialNumber: string;
  readonly amount: number;
  readonly count: number;
  readonly holdKey: string;
  readonly userKey: string;
};
type Reservation = {
  readonly authDataCard: string;
  readonly authDataAuth: string;
  readonly holdKey: string;
  readonly userKey: string;
};

function userKey(context: GoBusContext) {
  return JSON.stringify([context.userNumber, context.session.uuid]);
}
function holdKey(hold: GoBusHold) {
  return JSON.stringify([hold.trip.service, purchaseBody(hold)]);
}
function purchaseBody(hold: GoBusHold) {
  switch (hold.trip.service) {
    case "express":
      return buildGoExpressIssueBody(hold);
    case "intercity":
      return buildGoIssueBody(hold);
    default:
      return assertNever(hold.trip);
  }
}
function assertNever(_value: never): never {
  throw new GoPurchaseError("unsupported");
}

export class TmoneyGoPurchaseClient {
  readonly #account: GoPurchaseHttp;
  readonly #reconciler: GoPurchaseReconciler;
  readonly #expressReconciler: GoExpressReconciler;
  readonly #bus: GoBusHttp;
  readonly #preparations = new WeakMap<GoPaymentPreparation, Preparation>();
  readonly #reservations = new WeakMap<GoPaymentReservation, Reservation>();

  constructor(
    options: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number } = {},
  ) {
    this.#account = new GoPurchaseHttp(options);
    this.#bus = new GoBusHttp(options);
    this.#reconciler = new GoPurchaseReconciler(this.#bus, this.#account);
    this.#expressReconciler = new GoExpressReconciler(this.#bus);
  }

  async captureReceiptBaseline(
    context: GoBusContext,
    memberSerialNumber: string,
    service: BusService,
  ): Promise<readonly string[]> {
    switch (service) {
      case "intercity":
        return [];
      case "express":
        return captureGoExpressReceiptBaseline(this.#bus, context, memberSerialNumber);
      default:
        return assertNever(service);
    }
  }

  async checkAvailability(context: GoBusContext, service: "intercity" | "express"): Promise<void> {
    try {
      await this.#readAutomaticPayId(context, service);
    } catch (error) {
      if (error instanceof GoPurchaseError) throw new GoPurchaseError("payment_unavailable");
      throw error;
    }
  }

  async #readAutomaticPayId(
    context: GoBusContext,
    service: "intercity" | "express",
  ): Promise<string> {
    const raw = await this.#account.post(context, "api/pym/v2/inqrPymMnsListAtPym", {
      utlzSvcDvsCd: paymentServices[service].code,
    });
    const parsed = GoPaymentResponseSchema.safeParse(raw);
    if (
      !parsed.success ||
      !canUseAutomaticNpay(summarizeGoPayments(parsed.data.dta).paymentMethods)
    )
      throw new GoPurchaseError("payment_unavailable");
    const key = text.safeParse(parsed.data.dta.npayautPymInfo?.automaticPayId);
    if (!key.success) throw new GoPurchaseError("payment_unavailable");
    return key.data;
  }

  async prepare(
    context: GoBusContext,
    hold: GoBusHold,
    memberSerialNumber: string,
  ): Promise<GoPaymentPreparation> {
    if (!("seats" in hold) || hold.trip.expectedTotalFareKrw === undefined)
      throw new GoPurchaseError("unsupported");
    const key = holdKey(hold);
    if (!text.safeParse(memberSerialNumber).success) throw new GoPurchaseError("configuration");
    const service = hold.trip.service;
    const automaticPayId = await this.#readAutomaticPayId(context, service);
    const prepared = new GoPaymentPreparation();
    this.#preparations.set(prepared, {
      service,
      automaticPayId,
      memberSerialNumber,
      amount: hold.trip.expectedTotalFareKrw,
      count: hold.seats.length,
      holdKey: key,
      userKey: userKey(context),
    });
    return prepared;
  }

  async reserve(
    context: GoBusContext,
    prepared: GoPaymentPreparation,
  ): Promise<GoPaymentReservation> {
    const data = this.#preparations.get(prepared);
    if (!data || data.userKey !== userKey(context)) throw new GoPurchaseError("configuration");
    this.#preparations.delete(prepared);
    const response = await this.#account.postWithStatus(context, "api/pym/npay/v1/autoReserve", {
      moappMbrsSno: data.memberSerialNumber,
      automaticPayId: data.automaticPayId,
      utlzSvcDvsCd: paymentServices[data.service].code,
      productCount: data.count,
      productName: paymentServices[data.service].product,
      productAmount: data.amount,
    });
    const parsed = reserveSchema.safeParse(response.data);
    if (!parsed.success)
      throw new GoPurchaseError(
        "reserve_uncertain",
        reserveFailureDiagnostic(response.data, response.status),
      );
    const result = new GoPaymentReservation(parsed.data.dta.oderSno);
    this.#reservations.set(result, {
      authDataCard: parsed.data.dta.authDataCard,
      authDataAuth: parsed.data.dta.authDataAuth,
      holdKey: data.holdKey,
      userKey: data.userKey,
    });
    return result;
  }

  async issue(
    context: GoBusContext,
    hold: GoBusHold,
    reservation: GoPaymentReservation,
  ): Promise<void> {
    if (!("seats" in hold) || hold.trip.expectedTotalFareKrw === undefined)
      throw new GoPurchaseError("unsupported");
    const data = this.#reservations.get(reservation);
    if (!data || data.userKey !== userKey(context) || data.holdKey !== holdKey(hold))
      throw new GoPurchaseError("configuration");
    this.#reservations.delete(reservation);
    const service = hold.trip.service;
    const fields = paymentServices[service];
    try {
      await this.#bus.post(context, {
        service,
        path: "ticket/insertTckCad_CR.do",
        mutation: "purchase",
        body: {
          ...purchaseBody(hold),
          [fields.auth]: { card: data.authDataCard, auth: data.authDataAuth },
          [fields.order]: reservation.orderNumber,
          [fields.customer]: "00",
        },
      });
    } catch (error) {
      if (error instanceof GoBusError && error.code === "rejected")
        throw new GoPurchaseError("rejected");
      throw new GoPurchaseError("purchase_uncertain");
    }
  }

  reconcile(context: GoBusContext, lookup: GoPurchaseLookup): Promise<GoPurchaseOutcome> {
    switch (lookup.hold.trip.service) {
      case "express":
        return this.#expressReconciler.reconcile(context, lookup);
      case "intercity":
        return this.#reconciler.reconcile(context, lookup);
      default:
        return assertNever(lookup.hold.trip);
    }
  }
}
