import type { CallToolResult } from "@modelcontextprotocol/server";
import { AuthenticationRequiredError } from "./auth-policy";
import { BookingError } from "./booking-types";
import { CancellationError } from "./cancellation-types";
import { GoAccountError } from "./go-account";
import { GoAuthError } from "./go-auth";
import { GoBusError } from "./go-bus-types";
import { GoPurchaseError } from "./go-purchase-types";
import { ProviderError } from "./provider";
import { UserStoreError } from "./user-types";
import { WatchError } from "./watch-types";

export const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export async function toolResult(
  operation: () => Promise<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    const data = await operation();
    return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
  } catch (error) {
    if (error instanceof AuthenticationRequiredError)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: error.code, connectionUrl: error.connectionUrl }),
          },
        ],
      };
    if (
      !(error instanceof ProviderError) &&
      !(error instanceof WatchError) &&
      !(error instanceof GoAccountError) &&
      !(error instanceof GoAuthError) &&
      !(error instanceof GoBusError) &&
      !(error instanceof GoPurchaseError) &&
      !(error instanceof BookingError) &&
      !(error instanceof CancellationError) &&
      !(error instanceof UserStoreError)
    )
      throw error;
    return {
      isError: true,
      content: [
        { type: "text", text: JSON.stringify({ error: error.code, message: error.message }) },
      ],
    };
  }
}
