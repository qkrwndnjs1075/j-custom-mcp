import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { BusProvider, TerminalSearch, TripSearch } from "../src/bus-provider";
import {
  type ExpressTrip,
  ExpressTripSchema,
  type SeatMap,
  SeatMapSchema,
  type Trip,
  TripSchema,
} from "../src/provider-types";
import { createBusServer } from "../src/tools";

export const expressTrip = (changes: Partial<ExpressTrip> = {}): ExpressTrip =>
  ExpressTripSchema.parse({
    service: "express",
    departureId: "021",
    arrivalId: "393",
    departureName: "센트럴시티(서울)",
    arrivalName: "서산",
    departureDate: "20261026",
    departureTime: "142000",
    scheduledDepartureTime: "142000",
    carrierId: "53",
    carrierName: "한양고속",
    busClassId: "1",
    busClassName: "우등",
    adultCount: 1,
    studentCount: 0,
    childCount: 0,
    remainingSeats: 19,
    totalSeats: null,
    adultFareKrw: null,
    fareQuotes: { adults: null, students: null, children: null },
    estimatedDurationMinutes: 110,
    expressIdentity: {
      allocationDepartureId: "021",
      allocationArrivalId: "393",
      discountCode: "0",
      webCheckoutEligible: true,
      privateBusinessAccrual: "N",
      childSafetySeats: "N",
      accessibleSeats: "N",
    },
    ...changes,
  });
export const expressSeats = (changes: Partial<SeatMap> = {}): SeatMap =>
  SeatMapSchema.parse({
    adultFareKrw: 15100,
    fareQuotes: {
      adults: { unitFareKrw: 15100, fareKindCode: null },
      students: null,
      children: { unitFareKrw: 7600, fareKindCode: null },
    },
    seats: [
      { number: 1, available: true, row: 1, column: 1, side: "left" },
      { number: 2, available: true, row: 1, column: 2, side: "left" },
    ],
    layoutStatus: "verified",
    adjacentGroups: [[1, 2]],
    ...changes,
  });
export const expressCriteria = {
  service: "express",
  departureId: "021",
  arrivalId: "393",
  date: "2026-10-26",
  time: "14:00",
  endTime: "23:59",
  minSeats: 1,
  passengers: { adults: 1, students: 0, children: 0 },
  ranking: ["fare"],
} as const;

export class ExpressFixtureProvider implements BusProvider {
  readonly searches: TripSearch[] = [];
  readonly seatTrips: Trip[] = [];
  readonly terminalSearches: TerminalSearch[] = [];
  constructor(
    readonly trips: readonly Trip[] = [expressTrip()],
    readonly seats: SeatMap = expressSeats(),
  ) {}
  async searchTerminals(search: TerminalSearch) {
    this.terminalSearches.push(search);
    return [{ service: search.service, id: "021", name: "센트럴시티(서울)", area: "서울" }];
  }
  async searchTripPage(search: TripSearch) {
    this.searches.push(search);
    return {
      trips: this.trips
        .filter(
          (trip) =>
            trip.service === search.service &&
            trip.departureId === search.departureId &&
            trip.arrivalId === search.arrivalId,
        )
        .map((trip) =>
          TripSchema.parse({
            ...trip,
            adultCount: search.passengers.adults,
            studentCount: search.passengers.students,
            childCount: search.passengers.children,
          }),
        ),
      unavailable: [],
      continuation: null,
      coverage: "end" as const,
      emptyStatus: "none" as const,
    };
  }
  async getSeats(trip: Trip) {
    this.seatTrips.push(trip);
    return this.seats;
  }
}
export async function expressMcp(services: Parameters<typeof createBusServer>[0]) {
  const server = createBusServer(services);
  const client = new Client({ name: "express-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
