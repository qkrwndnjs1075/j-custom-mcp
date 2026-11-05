import type { BusService } from "./bus-service";
import type { GoPaymentStatus } from "./go-account";

export type AccountStatusService = {
  readonly getStatus: (
    service: BusService,
  ) => Promise<GoPaymentStatus | { readonly connection: "not_connected" | "not_configured" }>;
};
