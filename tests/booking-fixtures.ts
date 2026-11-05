import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BookingServices } from "../src/booking-context";
import { BookingRunner } from "../src/booking-runner";
import { BookingStore } from "../src/booking-store";
import { BookingSpecSchema } from "../src/booking-types";
import { type GoBusHold, GoBusRowSchema, GoBusSeatInfoSchema } from "../src/go-bus-types";
import { GoCredentialsSchema } from "../src/go-credentials";
import {
  GoPaymentPreparation,
  GoPaymentReservation,
  type GoPurchaseOutcome,
} from "../src/go-purchase";
import { TripSchema } from "../src/provider-types";

export const initialTime = Date.parse("2026-10-30T08:00:00+09:00");
export const credentials = {
  ...GoCredentialsSchema.parse({
    token: "synthetic-secret-token",
    uuid: "synthetic-device",
    appCode: "MIC",
    appVer: "2.7.1",
    osKnd: "A",
    osVer: "34",
    moappMbrsSno: "synthetic-member-secret",
    busUserNumber: "synthetic-user-secret",
    refreshSalt: "synthetic-salt-secret",
    osRelease: "14",
    country: "KR",
  }),
  connectionId: "synthetic-connection-original",
};
export function specification() {
  return BookingSpecSchema.parse({
    version: 2,
    payment: { method: "naver_pay_auto" },
    discounts: { mode: "none" },
    seatPolicy: { mode: "first_available", order: "ascending", passengerOrder: ["adult"] },
    idempotencyKey: crypto.randomUUID(),
    criteria: {
      service: "intercity",
      departureId: "0000001",
      arrivalId: "0000002",
      date: "2026-10-30",
      maxFareKrw: 20000,
      time: "00:00",
      endTime: "23:59",
      minSeats: 1,
      passengers: { adults: 1, students: 0, children: 0 },
      ranking: ["departure_time"],
    },
    expiresAt: "2026-10-30T09:00:00+09:00",
    intervalSeconds: 300,
  });
}
export const webTrip = TripSchema.parse({
  routeId: "00123",
  routeSequence: "01",
  serviceDate: "20261030",
  serviceSequence: "0007",
  service: "intercity",
  departureId: "0000001",
  arrivalId: "0000002",
  departureName: "Synthetic A",
  arrivalName: "Synthetic B",
  scheduledDepartureTime: "100000",
  carrierId: "03",
  busClassId: "1",
  carrierName: "Synthetic",
  busClassName: "Synthetic",
  adultCount: 1,
  studentCount: 0,
  childCount: 0,
  remainingSeats: 3,
  totalSeats: 4,
  departureDate: "20261030",
  departureTime: "100000",
  discountAvailable: "N",
  adultFareKrw: 15000,
});
const row = GoBusRowSchema.parse({
  rotid: "00123",
  rotsqno: "01",
  alcndt: "20261030",
  alcnsqno: "0007",
  timdte: "20261030",
  timtim: "1000",
  timtimo: "0930",
  terfri: "0000001",
  tertoi: "0000002",
  terfro: "0000099",
  tertoo: "0000088",
  busgrao: "1",
  corcodo: "03",
  afcownrdvscd: "01",
  adltfee: 15000,
  lintim: "0130",
  tckpay: "Y",
});
export const trip = {
  service: "intercity" as const,
  row,
  expectedAdultFareKrw: 15000,
  expectedTotalFareKrw: 15000,
  passengers: { adults: 1, students: 0, children: 0 },
  departureTerminal: { TER_COD: "0000001" },
  arrivalTerminal: { TER_COD: "0000002" },
};
export const info = GoBusSeatInfoSchema.parse({
  tckfee1: "15000",
  totcnt: "4",
  seatlist: [{ "01": "Y", "03": "Y" }],
  DIST: "100",
});
export const held = {
  trip,
  info,
  seats: [
    { seat: "01", holdId: "synthetic-hold-private", ticketKind: "IG00", passengerType: "adult" },
  ],
} satisfies GoBusHold;
type Action =
  | "scan"
  | "holdRead"
  | "hold"
  | "checkAvailability"
  | "prepare"
  | "reserve"
  | "issue"
  | "reconcile"
  | "release";

export function harness() {
  const directory = mkdtempSync(join(tmpdir(), "booking-test-"));
  const path = join(directory, "bookings.sqlite");
  const state = {
    now: initialTime,
    credentials,
    outcome: initialOutcome(),
    available: true,
    refreshCount: 0,
  };
  const actions: { readonly action: Action; readonly stage: string | undefined }[] = [];
  const hooks: Partial<Record<Action, () => void | Promise<void>>> = {};
  const store = new BookingStore(path, "synthetic-principal", () => state.now);
  const action = async (name: Action) => {
    actions.push({ action: name, stage: store.records()[0]?.stage });
    await hooks[name]?.();
  };
  const account: BookingServices["credentials"] = {
    async read() {
      return state.credentials;
    },
    async refresh() {
      state.refreshCount++;
      return state.credentials;
    },
  };
  const bus: BookingServices["bus"] = {
    async findTrip() {
      return trip;
    },
    async readSeats() {
      return { trip, info, selectableSeats: [3, 1] };
    },
    async hold(_context, input) {
      await action("holdRead");
      await input.beforeMutation?.();
      await action("hold");
      return {
        ...held,
        seats: input.seats.map((assignment) => ({
          seat: String(assignment.seat).padStart(2, "0"),
          holdId: "synthetic-hold-private",
          ticketKind: "IG00",
          passengerType: assignment.passengerType,
        })),
      };
    },
    async release() {
      await action("release");
      return { businessAccepted: true };
    },
  };
  const purchase: BookingServices["purchase"] = {
    async captureReceiptBaseline() {
      return [];
    },
    async checkAvailability() {
      await action("checkAvailability");
    },
    async prepare() {
      await action("prepare");
      return new GoPaymentPreparation();
    },
    async reserve() {
      await action("reserve");
      return new GoPaymentReservation("synthetic-payment-order-private");
    },
    async issue() {
      await action("issue");
    },
    async reconcile() {
      await action("reconcile");
      return state.outcome.status === "confirmed"
        ? {
            ...state.outcome,
            seat: String(store.records()[0]?.selection?.seat ?? 1).padStart(2, "0"),
          }
        : state.outcome;
    },
  };
  const query = {
    async scan() {
      await action("scan");
      return { matches: state.available ? [{ trip: webTrip }] : [], complete: true, reasons: [] };
    },
  };
  const options = {
    store,
    query,
    credentials: account,
    bus,
    purchase,
    now: () => state.now,
    ipAddress: () => "",
  };
  return {
    directory,
    path,
    store,
    state,
    actions,
    hooks,
    options,
    runner: new BookingRunner(options),
  };
}

function initialOutcome(): GoPurchaseOutcome {
  return {
    status: "confirmed",
    orderNumber: "synthetic-order-private",
    ticketNumber: "synthetic-ticket-private",
    seat: "01",
    fareKrw: 15000,
  };
}
