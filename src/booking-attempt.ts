import {
  type BookingChoice,
  BookingGateError,
  type BookingServices,
  bookingGate,
  bookingMonth,
} from "./booking-context";
import { type BookingFailure, type BookingRecord, bookingBinding } from "./booking-types";
import { type GoBusContext, GoBusError } from "./go-bus-types";
import {
  type GoPaymentPreparation,
  type GoPaymentReservation,
  GoPurchaseError,
} from "./go-purchase";

export class BookingAttempt {
  constructor(readonly services: BookingServices) {}

  async run(record: BookingRecord, choice: BookingChoice): Promise<void> {
    const selection = {
      service: choice.trip.service,
      departureDate: choice.trip.row.timdte,
      departureTime: choice.trip.row.timtim.padEnd(6, "0"),
      departureName: choice.departureName,
      arrivalName: choice.arrivalName,
      seat: choice.seats[0].seat,
      seats: choice.seats.map((seat) => seat.seat),
      fareKrw: choice.fareKrw,
    };
    let context: GoBusContext;
    let receiptBaseline: readonly string[] | null = null;
    try {
      context = await bookingGate(this.services, { ...record, selection }, true);
      await this.services.purchase.checkAvailability(context, choice.trip.service);
      if (choice.trip.service === "express") {
        const credentials = await this.services.credentials.read();
        if (bookingBinding(credentials) !== record.bindingHash)
          throw new BookingGateError("account_changed");
        receiptBaseline = await this.services.purchase.captureReceiptBaseline(
          context,
          credentials.moappMbrsSno,
          choice.trip.service,
        );
      }
      context = await bookingGate(this.services, { ...record, selection }, true);
    } catch (error) {
      const code = error instanceof BookingGateError ? error.code : "payment_unavailable";
      this.services.store.transition(
        record,
        code === "deadline" || code === "departure_passed" ? "expired" : "failed",
        { lastError: code },
      );
      return;
    }
    const holding = this.services.store.transition(record, "holding", {
      selection,
      receiptBaseline,
      checkCount: record.checkCount + 1,
    });
    if (!holding) return;
    let held: BookingRecord | undefined;
    try {
      const hold = await this.services.bus.hold(context, {
        trip: choice.trip,
        seats: choice.seats,
        beforeMutation: async () => {
          await bookingGate(this.services, holding, true);
          if (this.services.store.read(holding.id)?.revision !== holding.revision)
            throw new BookingGateError("account_changed");
        },
      });
      held = this.services.store.transition(holding, "held", { hold });
    } catch (error) {
      if (error instanceof BookingGateError) {
        this.services.store.transition(
          holding,
          error.code === "deadline" || error.code === "departure_passed" ? "expired" : "failed",
          { lastError: error.code },
        );
        return;
      }
      const definitive =
        error instanceof GoBusError &&
        ["rejected", "fare_changed", "seat_unavailable"].includes(error.code);
      this.services.store.transition(holding, definitive ? "failed" : "uncertain", {
        lastError: definitive ? "hold_rejected" : "hold_uncertain",
      });
      return;
    }
    if (!held?.hold) return;
    await this.#reserve(held, context);
  }

  async #reserve(held: BookingRecord, heldContext: GoBusContext): Promise<void> {
    if (!held.hold) return;
    let context: GoBusContext;
    let prepared: GoPaymentPreparation;
    try {
      context = await bookingGate(this.services, held, true);
      const credentials = await this.services.credentials.read();
      if (bookingBinding(credentials) !== held.bindingHash)
        throw new BookingGateError("account_changed");
      prepared = await this.services.purchase.prepare(context, held.hold, credentials.moappMbrsSno);
      context = await bookingGate(this.services, held, true);
    } catch (error) {
      const code = error instanceof BookingGateError ? error.code : "payment_unavailable";
      await this.#stopBeforeBilling(held, heldContext, code);
      return;
    }
    const reserving = this.services.store.transition(held, "reserving", {
      purchaseMonth: bookingMonth(this.services.now()),
    });
    if (!reserving) return;
    let reservation: GoPaymentReservation;
    try {
      reservation = await this.services.purchase.reserve(context, prepared);
    } catch (error) {
      const code = error instanceof GoPurchaseError ? "reserve_uncertain" : "internal";
      this.services.store.transition(reserving, "uncertain", {
        lastError: code,
        ...(error instanceof GoPurchaseError && error.diagnostic
          ? { failureDiagnostic: error.diagnostic }
          : {}),
      });
      return;
    }
    const reserved = this.services.store.transition(reserving, "reserved", {
      paymentOrderNumber: reservation.orderNumber,
    });
    if (!reserved?.hold) return;
    try {
      context = await bookingGate(this.services, reserved, true);
    } catch (error) {
      this.services.store.transition(reserved, "uncertain", {
        lastError: error instanceof BookingGateError ? error.code : "internal",
      });
      return;
    }
    const issuing = this.services.store.transition(reserved, "issuing", { issueAttempted: true });
    if (!issuing) return;
    let lastError: BookingFailure | null = null;
    try {
      await this.services.purchase.issue(context, reserved.hold, reservation);
    } catch (error) {
      lastError =
        error instanceof GoPurchaseError || error instanceof GoBusError
          ? "issue_uncertain"
          : "internal";
    }
    const reconciling = this.services.store.transition(issuing, "reconciling", { lastError });
    if (reconciling) await this.reconcile(reconciling);
  }

  async #stopBeforeBilling(held: BookingRecord, context: GoBusContext, code: BookingFailure) {
    const stage = code === "deadline" || code === "departure_passed" ? "expired" : "failed";
    const stopped = this.services.store.transition(held, stage, { lastError: code });
    if (!stopped?.hold) return;
    try {
      const released = await this.services.bus.release(context, stopped.hold);
      this.services.store.transition(stopped, stage, {
        releaseAccepted: released.businessAccepted,
      });
    } catch (error) {
      this.services.store.transition(stopped, stage, {
        lastError: error instanceof GoBusError ? "release_uncertain" : "internal",
      });
    }
  }

  async reconcile(record: BookingRecord): Promise<void> {
    const current =
      record.stage === "uncertain" ? this.services.store.transition(record, "reconciling") : record;
    if (!current?.hold || !current.purchaseMonth || !current.issueAttempted) return;
    try {
      await bookingGate(this.services, current, false);
      const credentials = await this.services.credentials.refresh();
      if (bookingBinding(credentials) !== current.bindingHash)
        throw new BookingGateError("account_changed");
      const context = await bookingGate(this.services, current, false);
      const outcome = await this.services.purchase.reconcile(context, {
        hold: current.hold,
        memberSerialNumber: credentials.moappMbrsSno,
        purchaseMonth: current.purchaseMonth,
        ...(current.receiptBaseline === null ? {} : { receiptBaseline: current.receiptBaseline }),
        ...(current.paymentOrderNumber === null
          ? {}
          : { paymentOrderNumber: current.paymentOrderNumber }),
      });
      if (outcome.status === "confirmed") {
        this.services.store.transition(current, "booked", { lastError: null });
      } else this.#uncertain(current, "reconciliation_pending");
    } catch (error) {
      this.#uncertain(
        current,
        error instanceof BookingGateError ? error.code : "reconciliation_pending",
      );
    }
  }

  #uncertain(record: BookingRecord, code: BookingFailure) {
    this.services.store.transition(record, "uncertain", {
      lastError: code,
      nextCheckAt: this.services.now() + record.spec.intervalSeconds * 1000,
    });
  }
}
