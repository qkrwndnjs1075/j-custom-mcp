import { z } from "zod";

export const PassengersSchema = z
  .strictObject({
    adults: z.number().int().nonnegative().safe(),
    students: z.number().int().nonnegative().safe(),
    children: z.number().int().nonnegative().safe(),
  })
  .refine(
    (value) => {
      const count = value.adults + value.students + value.children;
      return Number.isSafeInteger(count) && count > 0;
    },
    {
      message: "Passenger total must be a positive safe integer",
    },
  )
  .readonly();
export type Passengers = z.infer<typeof PassengersSchema>;
export const passengerCount = (value: Passengers): number =>
  value.adults + value.students + value.children;
const FareQuoteSchema = z
  .object({
    unitFareKrw: z.number().int().nonnegative().safe(),
    fareKindCode: z.string().min(1).nullable(),
  })
  .readonly();
export const FareQuotesSchema = z
  .object({
    adults: FareQuoteSchema.nullable(),
    students: FareQuoteSchema.nullable(),
    children: FareQuoteSchema.nullable(),
  })
  .readonly();
export type FareQuotes = z.infer<typeof FareQuotesSchema>;
export function totalFare(passengers: Passengers, quotes: FareQuotes): number | null {
  let total = 0;
  for (const kind of ["adults", "students", "children"] as const) {
    if (passengers[kind] === 0) continue;
    const quote = quotes[kind];
    if (quote === null) return null;
    total += passengers[kind] * quote.unitFareKrw;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}
