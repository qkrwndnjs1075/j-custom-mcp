import type { BusProvider, TerminalSearch, TripSearch } from "./bus-provider";
import { type BusService, terminalMatchesService } from "./bus-service";
import { KobusExpressClient } from "./express-provider";
import { TmoneyIntercityClient } from "./provider";
import { ProviderError, type Trip } from "./provider-types";

export class TmoneyBusClient implements BusProvider {
  constructor(
    private readonly intercity: BusProvider = new TmoneyIntercityClient(),
    private readonly express: BusProvider = new KobusExpressClient(),
  ) {}

  private provider(service: BusService): BusProvider {
    switch (service) {
      case "intercity":
        return this.intercity;
      case "express":
        return this.express;
    }
  }

  searchTerminals(search: TerminalSearch) {
    if (search.departureId && !terminalMatchesService(search.service, search.departureId))
      throw new ProviderError("unavailable", "Terminal does not belong to the selected service");
    return this.provider(search.service).searchTerminals(search);
  }

  searchTripPage(search: TripSearch) {
    if (
      !terminalMatchesService(search.service, search.departureId) ||
      !terminalMatchesService(search.service, search.arrivalId)
    )
      throw new ProviderError("unavailable", "Terminals do not belong to the selected service");
    return this.provider(search.service).searchTripPage(search);
  }

  getSeats(trip: Trip) {
    return this.provider(trip.service).getSeats(trip);
  }
}
