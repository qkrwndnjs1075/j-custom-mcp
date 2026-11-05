import {
  type AuthInfo,
  createMcpHandler,
  type McpServer,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { permitsPublicRequest } from "./auth-policy";
import { UserIdSchema } from "./user-types";

type HttpOptions = {
  readonly createPublicServer?: () => McpServer;
  readonly createServer: (authInfo: AuthInfo) => McpServer;
  readonly authenticate: (request: Request) => Promise<AuthInfo | Response>;
  readonly allowedHosts: readonly string[];
  /** Hostnames only, following the SDK's Origin allowlist convention. */
  readonly allowedOrigins?: readonly string[];
  readonly publicHandlers?: readonly ((
    request: Request,
  ) => Response | undefined | Promise<Response | undefined>)[];
};

const hostname = z
  .string()
  .min(1)
  .refine((value) => {
    if (value.includes("*")) return false;
    const parsed = validateHostHeader(value, [value]);
    return parsed.ok;
  });
const configSchema = z.object({
  allowedHosts: z.array(hostname).min(1),
  allowedOrigins: z.array(hostname).default([]),
});

export function createHttpHandler(options: HttpOptions): (request: Request) => Promise<Response> {
  const config = configSchema.parse(options);
  if (typeof options.authenticate !== "function") throw new TypeError("Authentication is required");
  const subjectSchema = z.object({ subject: UserIdSchema });
  const handler = createMcpHandler((context) => {
    if (!context.authInfo && options.createPublicServer) return options.createPublicServer();
    if (!context.authInfo || !subjectSchema.safeParse(context.authInfo.extra).success)
      throw new Error("Authentication required");
    return options.createServer(context.authInfo);
  });

  return async (request) => {
    if (
      !validateHostHeader(request.headers.get("host"), config.allowedHosts).ok ||
      !validateOriginHeader(request.headers.get("origin"), config.allowedOrigins).ok
    ) {
      return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/health" && request.method === "GET") {
      return Response.json({ status: "ok" });
    }
    try {
      for (const publicHandler of options.publicHandlers ?? []) {
        const response = await publicHandler(request);
        if (response) return response;
      }
      if ((path !== "/mcp" && path !== "/mcp/account") || (path === "/mcp/account" && url.search))
        return new Response("Not found", { status: 404 });
      if (
        path === "/mcp" &&
        options.createPublicServer &&
        !request.headers.has("authorization") &&
        (await permitsPublicRequest(request))
      )
        return await handler.fetch(request);
      const authInfo = await options.authenticate(request);
      if (authInfo instanceof Response) return authInfo;
      if (!subjectSchema.safeParse(authInfo.extra).success)
        return new Response("Unauthorized", { status: 401 });
      return await handler.fetch(request, { authInfo });
    } catch {
      return new Response("Service unavailable", { status: 503 });
    }
  };
}
