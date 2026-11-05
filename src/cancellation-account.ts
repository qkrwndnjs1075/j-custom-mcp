import { bookingContext, localBookingIp } from "./booking-context";
import { bookingBinding } from "./booking-types";
import { CancellationError } from "./cancellation-types";
import { GoBusError } from "./go-bus-types";
import type { GoTicketAccount } from "./go-ticket-types";
import type { UserCredentialStore, UserCredentials } from "./user-credentials";

export class CancellationAccount {
  constructor(
    private readonly credentials: Pick<UserCredentialStore, "read" | "refresh" | "assertCurrent">,
  ) {}
  async read(binding?: string): Promise<UserCredentials> {
    const credentials = await this.credentials.read();
    if (binding !== undefined && bookingBinding(credentials) !== binding)
      throw new CancellationError("account_changed");
    this.credentials.assertCurrent(credentials);
    return credentials;
  }
  context(credentials: UserCredentials): GoTicketAccount {
    this.credentials.assertCurrent(credentials);
    return {
      bindingHash: bookingBinding(credentials),
      context: bookingContext(credentials, localBookingIp()),
      memberSerialNumber: credentials.moappMbrsSno,
    };
  }
  async query<T>(binding: string, operation: (account: GoTicketAccount) => Promise<T>): Promise<T> {
    const credentials = await this.read(binding);
    let result: T;
    try {
      result = await operation(this.context(credentials));
    } catch (error) {
      if (!(error instanceof GoBusError) || error.code !== "authentication_required") throw error;
      const renewed = await this.credentials.refresh(credentials);
      if (bookingBinding(renewed) !== binding) throw new CancellationError("account_changed");
      result = await operation(this.context(renewed));
    }
    await this.read(binding);
    return result;
  }
}
