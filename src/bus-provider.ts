import { z } from "zod";
import type { BusService } from "./bus-service";
import { BusServiceSchema, TerminalIdSchema, terminalMatchesService } from "./bus-service";
import type { Passengers } from "./passengers";
import { PassengersSchema } from "./passengers";
import type { SeatMap, Terminal, Trip, TripPage } from "./provider-types";

export type TerminalSearch = {
  readonly service: BusService;
  readonly query: string;
  readonly departureId?: string;
};
export type TripSearch = {
  readonly service: BusService;
  readonly departureId: string;
  readonly arrivalId: string;
  readonly date: string;
  readonly time: string;
  readonly passengers: Passengers;
  readonly continuation?: string | undefined;
};
export interface BusProvider {
  searchTerminals(search: TerminalSearch): Promise<readonly Terminal[]>;
  searchTripPage(search: TripSearch): Promise<TripPage>;
  getSeats(trip: Trip): Promise<SeatMap>;
}

export const TerminalSearchSchema = z
  .object({
    service: BusServiceSchema,
    query: z.string().trim().min(1).max(50),
    departureId: TerminalIdSchema.optional(),
  })
  .refine(
    (input) =>
      input.departureId === undefined || terminalMatchesService(input.service, input.departureId),
    { message: "Terminal ID must belong to the selected bus service" },
  );

export const TripSearchSchema = z
  .object({
    service: BusServiceSchema,
    departureId: TerminalIdSchema,
    arrivalId: TerminalIdSchema,
    date: z.iso.date(),
    time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    passengers: PassengersSchema,
    continuation: z.string().min(1).max(4096).optional(),
  })
  .refine(
    (input) =>
      terminalMatchesService(input.service, input.departureId) &&
      terminalMatchesService(input.service, input.arrivalId),
    { message: "Terminal IDs must belong to the selected bus service" },
  );
