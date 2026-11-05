import { z } from "zod";
import { PaymentQuerySchema } from "./payment-query";

export const PUBLIC_TOOL_NAMES = [
  "get_service_capabilities",
  "search_terminals",
  "search_trips",
  "get_seats",
  "find_journeys",
  "prepare_checkout",
  "get_payment_options",
] as const;
const publicTools = new Set<string>(PUBLIC_TOOL_NAMES);
const envelope = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string(),
  params: z.unknown().optional(),
  id: z.union([z.string(), z.number()]).optional(),
});

export async function permitsPublicRequest(request: Request): Promise<boolean> {
  if (request.method === "GET") return true;
  if (request.method !== "POST") return false;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return false;
  }
  const parsed = envelope.safeParse(body);
  if (!parsed.success) return false;
  switch (parsed.data.method) {
    case "initialize":
    case "tools/list":
    case "ping":
    case "notifications/initialized":
      return true;
    case "tools/call": {
      const params = z
        .object({ name: z.string(), arguments: z.unknown().optional() })
        .safeParse(parsed.data.params);
      if (!params.success || !publicTools.has(params.data.name)) return false;
      if (params.data.name !== "get_payment_options") return true;
      const query = PaymentQuerySchema.safeParse(params.data.arguments);
      return query.success && "tripRef" in query.data;
    }
    default:
      return false;
  }
}

export class AuthenticationRequiredError extends Error {
  override readonly name = "AuthenticationRequiredError";
  readonly code = "auth_required";
  constructor(readonly connectionUrl: string) {
    super("Account connection required");
  }
}

export type ServiceSource<T extends object> = T | (() => T);
export function resolveService<T extends object>(source: ServiceSource<T>): T {
  return typeof source === "function" ? source() : source;
}
