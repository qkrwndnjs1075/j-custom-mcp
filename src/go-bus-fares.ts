import { z } from "zod";
import {
  GoBusError,
  type GoBusHold,
  type GoBusSeatInfo,
  type GoHeldSeat,
  type GoPassengerType,
  type GoTicketKind,
} from "./go-bus-types";

// Native seat 99 denotes unreserved travel and omits the hold ID at issuance.
export const GO_MAX_SEAT_NUMBER = 98;
export const GO_PURCHASE_CAPABILITIES = {
  paymentMethods: ["naver_pay_auto"],
  discountModes: ["none"],
  passengerTypes: ["adult", "student", "child"],
} as const;
export const GoHeldSeatSchema = z
  .strictObject({
    seat: z.string().regex(/^(?:0[1-9]|[1-8][0-9]|9[0-8])$/),
    holdId: z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => !value.includes(":")),
    ticketKind: z.enum(["IG00", "IC50", "IM10", "IM20", "IM30", "1", "2", "9"]),
    passengerType: z.enum(["adult", "student", "child"]),
  })
  .readonly();
export const GoProviderSeatSchema = z
  .string()
  .regex(/^\d{1,2}$/)
  .transform((seat) => seat.padStart(2, "0"))
  .pipe(GoHeldSeatSchema.unwrap().shape.seat);
export const GoSeatSelectionSchema = z
  .array(
    z.strictObject({
      seat: z.number().int().min(1).max(GO_MAX_SEAT_NUMBER),
      passengerType: z.enum(["adult", "student", "child"]),
    }),
  )
  .min(1)
  .max(GO_MAX_SEAT_NUMBER)
  .refine((seats) => new Set(seats.map((value) => value.seat)).size === seats.length);

export function goTicketKind(
  info: GoBusSeatInfo,
  passenger: GoPassengerType,
  service: "intercity" | "express" = "intercity",
): GoTicketKind {
  const expressKinds = { adult: "1", child: "2", student: "9" } as const;
  switch (service) {
    case "express":
      return expressKinds[passenger];
    case "intercity":
      break;
    default:
      return assertNever(service);
  }
  switch (passenger) {
    case "adult":
      return "IG00";
    case "child":
      return "IC50";
    case "student": {
      const options = [
        ["IM30", info.tckfee93],
        ["IM20", info.tckfee92],
        ["IM10", info.tckfee91],
      ] as const;
      const selected = options.find(
        ([, fee]) => fee !== undefined && /^\d+$/.test(fee) && Number(fee) > 0,
      );
      if (!selected) throw new GoBusError("fare_changed");
      return selected[0];
    }
    default:
      return assertNever(passenger);
  }
}
function assertNever(_value: never): never {
  throw new GoBusError("input");
}
export function goSeatFare(info: GoBusSeatInfo, kind: GoTicketKind): number {
  const values = {
    IG00: info.tckfee1,
    IC50: info.tckfee2,
    IM10: info.tckfee91,
    IM20: info.tckfee92,
    IM30: info.tckfee93,
    "1": info.tckfee1,
    "2": info.tckfee2,
    "9": info.tckfee9,
  };
  const value = values[kind];
  if (
    value === undefined ||
    !/^\d+$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) <= 0
  )
    throw new GoBusError("fare_changed");
  return Number(value);
}
export function goHeldSeats(hold: GoBusHold): readonly GoHeldSeat[] {
  return "seats" in hold
    ? hold.seats
    : [
        {
          seat: hold.seat,
          holdId: hold.holdId,
          ticketKind: hold.ticketKind,
          passengerType: "adult",
        },
      ];
}
export function validateGoHoldFare(hold: GoBusHold): number {
  const seats = goHeldSeats(hold);
  if (
    seats.length === 0 ||
    new Set(seats.map((seat) => seat.seat)).size !== seats.length ||
    new Set(seats.map((seat) => seat.holdId)).size !== seats.length
  )
    throw new GoBusError("input");
  const counts = { adults: 0, students: 0, children: 0 };
  const categories = { adult: "adults", student: "students", child: "children" } as const;
  let total = 0;
  for (const seat of seats) {
    if (goTicketKind(hold.info, seat.passengerType, hold.trip.service) !== seat.ticketKind)
      throw new GoBusError("fare_changed");
    const fare = goSeatFare(hold.info, seat.ticketKind);
    const category = categories[seat.passengerType];
    counts[category]++;
    const quote = hold.trip.fareQuotes?.[category];
    if (hold.trip.fareQuotes && (!quote || quote.unitFareKrw !== fare))
      throw new GoBusError("fare_changed");
    total += fare;
  }
  if (
    hold.trip.passengers &&
    (["adults", "students", "children"] as const).some(
      (category) => counts[category] !== hold.trip.passengers?.[category],
    )
  )
    throw new GoBusError("input");
  if (total !== (hold.trip.expectedTotalFareKrw ?? hold.trip.expectedAdultFareKrw))
    throw new GoBusError("fare_changed");
  return total;
}
