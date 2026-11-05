export { localBookingIp } from "#local-runtime";

import type { BookingStore } from "./booking-store";
import {
  type BookingCredentialAdapter,
  type BookingCredentials,
  type BookingFailure,
  type BookingRecord,
  bookingBinding,
} from "./booking-types";
import { GoSessionSchema } from "./go-account";
import type { TmoneyGoBusClient } from "./go-bus";
import type { GoBusContext, GoBusTrip } from "./go-bus-types";
import type { GoCredentials } from "./go-credentials";
import type { TmoneyGoPurchaseClient } from "./go-purchase";

export type BookingServices = {
  readonly store: BookingStore;
  readonly credentials: BookingCredentialAdapter;
  readonly bus: Pick<TmoneyGoBusClient, "findTrip" | "readSeats" | "hold" | "release">;
  readonly purchase: Pick<
    TmoneyGoPurchaseClient,
    "captureReceiptBaseline" | "checkAvailability" | "prepare" | "reserve" | "issue" | "reconcile"
  >;
  readonly now: () => number;
  readonly ipAddress: () => string;
};
export type BookingChoice = {
  readonly trip: GoBusTrip;
  readonly fareKrw: number;
  readonly seats: readonly [
    { readonly seat: number; readonly passengerType: "adult" | "student" | "child" },
    ...{ readonly seat: number; readonly passengerType: "adult" | "student" | "child" }[],
  ];
  readonly departureName: string;
  readonly arrivalName: string;
};

export function bookingContext(credentials: GoCredentials, ipAddress: string): GoBusContext {
  return {
    session: GoSessionSchema.parse(credentials),
    userNumber: credentials.busUserNumber,
    osRelease: credentials.osRelease,
    country: credentials.country,
    ipAddress,
  };
}
export function bookingDeparture(date: string, time: string): number {
  return Date.parse(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6) || "00"}+09:00`,
  );
}
export function bookingMonth(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 7).replace("-", "");
}
export class BookingGateError extends Error {
  override readonly name = "BookingGateError";
  constructor(
    readonly code: Extract<
      BookingFailure,
      | "deadline"
      | "departure_passed"
      | "account_changed"
      | "authentication"
      | "reauthorization_required"
    >,
  ) {
    super(code);
  }
}
export async function bookingGate(
  services: BookingServices,
  record: BookingRecord,
  financial: boolean,
): Promise<GoBusContext> {
  if (financial && record.spec.version !== 2)
    throw new BookingGateError("reauthorization_required");
  let credentials: BookingCredentials;
  try {
    credentials = await services.credentials.read();
  } catch (error) {
    if (error instanceof BookingGateError) throw error;
    throw new BookingGateError("authentication");
  }
  if (bookingBinding(credentials) !== record.bindingHash)
    throw new BookingGateError("account_changed");
  if (financial && Date.parse(record.spec.expiresAt) <= services.now())
    throw new BookingGateError("deadline");
  if (
    financial &&
    record.selection &&
    bookingDeparture(record.selection.departureDate, record.selection.departureTime) <=
      services.now()
  ) {
    throw new BookingGateError("departure_passed");
  }
  return bookingContext(credentials, services.ipAddress());
}
