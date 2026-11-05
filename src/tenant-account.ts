import type { BusService } from "./bus-service";
import { GoAccountError, type GoPaymentStatus, TmoneyGoAccountClient } from "./go-account";
import { GoAuthError } from "./go-auth";
import type { UserCredentialStore } from "./user-credentials";
import { UserStoreError } from "./user-types";

export type AccountStatusService = {
  readonly getStatus: (
    service: BusService,
  ) => Promise<GoPaymentStatus | { readonly connection: "not_connected" }>;
};

export class TenantAccountService implements AccountStatusService {
  constructor(
    private readonly credentials: UserCredentialStore,
    private readonly client = new TmoneyGoAccountClient(),
  ) {}

  async getStatus(service: BusService): ReturnType<AccountStatusService["getStatus"]> {
    try {
      const credentials = await this.credentials.read();
      const status = await this.client
        .readPaymentStatus(credentials, service)
        .catch(async (error: unknown) => {
          if (!(error instanceof GoAccountError) || error.code !== "authentication_required")
            throw error;
          const renewed = await this.credentials.refresh(credentials);
          if (
            renewed.connectionId !== credentials.connectionId ||
            (await this.credentials.read()).connectionId !== credentials.connectionId
          )
            throw new UserStoreError("connection_changed");
          return this.client.readPaymentStatus(renewed, service);
        });
      if ((await this.credentials.read()).connectionId !== credentials.connectionId)
        throw new UserStoreError("connection_changed");
      return status;
    } catch (error) {
      if (error instanceof UserStoreError && error.code === "disconnected")
        return { connection: "not_connected" };
      if (error instanceof GoAccountError) throw error;
      if (error instanceof GoAuthError && error.code === "authentication_required")
        throw new GoAccountError("authentication_required");
      throw new GoAccountError("configuration");
    }
  }
}
