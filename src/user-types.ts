import { z } from "zod";

export const UserIdSchema = z.string().uuid().brand("UserId");
export type UserId = z.infer<typeof UserIdSchema>;
export type UserConnection = {
  readonly userId: UserId;
  readonly revision: number;
  readonly connected: boolean;
  readonly connectionId: string | null;
};

const messages = {
  capacity: "Account capacity reached. Existing account connections are preserved.",
  configuration: "Account storage configuration is invalid.",
  disconnected: "Connect your Tmoney GO account to continue.",
  connection_changed: "Account connection changed. Retry with the current connection.",
  integrity: "Account credentials could not be verified.",
} as const;

export class UserStoreError extends Error {
  override readonly name = "UserStoreError";
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}

export function safeUserStorage<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof UserStoreError) throw error;
    throw new UserStoreError("configuration");
  }
}
