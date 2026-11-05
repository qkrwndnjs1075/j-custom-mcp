import type { AuthInfo } from "@modelcontextprotocol/server";
import { UserIdSchema } from "../src/user-types";

export const syntheticSubject = UserIdSchema.parse("31ce88aa-f5b5-48d6-a0d1-d9e9a75db6ba");
export function syntheticAuthenticate(token: string) {
  return async (request: Request): Promise<AuthInfo | Response> => {
    if (request.headers.get("authorization") !== `Bearer ${token}`)
      return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="mcp"' },
      });
    return {
      token,
      clientId: "synthetic-client",
      scopes: ["mcp"],
      extra: { subject: syntheticSubject },
    };
  };
}
