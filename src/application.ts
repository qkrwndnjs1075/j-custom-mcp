import { join } from "node:path";
import { requireBearerAuth } from "@modelcontextprotocol/server";
import { loadGoRefreshSalt } from "#local-runtime";
import { type AppConfig, applicationLocation } from "./app-config";
import { AuthenticationRequiredError } from "./auth-policy";
import { AuthTokenStore } from "./auth-token-store";
import type { BusProvider } from "./bus-provider";
import { TmoneyBusClient } from "./bus-router";
import { ConnectionAuth } from "./connection-auth";
import { createConnectionHandler } from "./connection-http";
import { createHttpHandler } from "./http";
import { OAuthService } from "./oauth-service";
import { type TenantPersistence, TenantServices } from "./tenant-services";
import { createBusServer } from "./tools";
import type { StateStorage } from "./transient-state";
import { UserStore } from "./user-store";
import { UserIdSchema } from "./user-types";

export type ApplicationRuntime = {
  readonly users: UserStore;
  readonly tokens: AuthTokenStore;
  readonly persistence: TenantPersistence;
  readonly connectionState: StateStorage;
  readonly salt?: string;
  readonly provider?: BusProvider;
};

export async function createApplication(config: AppConfig, runtime?: ApplicationRuntime) {
  const { baseUrl, dataDirectory, allowLoopbackHttp } = applicationLocation(config);
  const salt = runtime
    ? runtime.salt
    : config.GO_APP_RESOURCES
      ? await loadGoRefreshSalt(config.GO_APP_RESOURCES)
      : undefined;
  const users =
    runtime?.users ??
    new UserStore(join(dataDirectory, "accounts.sqlite"), {
      accountLimit: config.MCP_LIMITS.accounts,
      ...(config.GO_VAULT_KEY_FILE ? { keyPath: config.GO_VAULT_KEY_FILE } : {}),
    });
  let tokens: AuthTokenStore | undefined;
  let tenants: TenantServices | undefined;
  try {
    tokens = runtime?.tokens ?? new AuthTokenStore(join(dataDirectory, "oauth.sqlite"));
    const publicResource = new URL("/mcp", baseUrl);
    const accountResource = new URL("/mcp/account", baseUrl);
    const oauth = new OAuthService({
      issuerUrl: baseUrl.href,
      resourceUrl: publicResource.href,
      additionalResourceUrls: [accountResource.href],
      store: tokens,
      allowLoopbackHttp,
    });
    const registry = new TenantServices({
      users,
      dataDirectory: join(dataDirectory, "users"),
      provider: runtime?.provider ?? new TmoneyBusClient(),
      limits: config.MCP_LIMITS,
      ...(runtime ? { persistence: runtime.persistence } : {}),
    });
    tenants = registry;
    const connection = createConnectionHandler({
      baseUrl,
      users,
      oauth,
      osVer: config.GO_OS_SDK,
      disconnect: (userId) => registry.disconnect(userId),
      ...(runtime ? { state: runtime.connectionState } : {}),
      ...(salt
        ? {
            auth: new ConnectionAuth({
              salt,
              osRelease: config.GO_OS_RELEASE,
              country: config.GO_COUNTRY,
            }),
          }
        : {}),
    });
    const authenticators = new Map(
      [publicResource, accountResource].map((resource) => {
        const resourceMetadataUrl = new URL(
          `/.well-known/oauth-protected-resource${resource.pathname}`,
          baseUrl,
        ).href;
        return [
          resource.pathname,
          {
            resourceMetadataUrl,
            authenticate: requireBearerAuth({
              verifier: oauth.verifierForResource(resource.href),
              expectedResource: resource,
              resourceMetadataUrl,
              requiredScopes: ["mcp"],
            }),
          },
        ] as const;
      }),
    );
    const fetch = createHttpHandler({
      authenticate: async (request) => {
        const selected = authenticators.get(new URL(request.url).pathname);
        if (!selected) return new Response("Not found", { status: 404 });
        const result = await selected.authenticate(request);
        if (result instanceof Response) return result;
        const { subject: rawSubject } = result.extra ?? {};
        const subject = UserIdSchema.safeParse(rawSubject);
        if (!subject.success || !users.status(subject.data)?.connected)
          return new Response("Account connection required", {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${selected.resourceMetadataUrl}"`,
            },
          });
        return result;
      },
      createPublicServer: () => {
        const requireConnection = (): never => {
          throw new AuthenticationRequiredError(new URL("/connect", baseUrl).href);
        };
        return createBusServer({
          ...registry.publicContext(),
          watches: requireConnection,
          bookings: requireConnection,
          cancellations: requireConnection,
          account: requireConnection,
          checkoutBaseUrl: baseUrl,
          connectionUrl: new URL("/connect", baseUrl).href,
          limits: config.MCP_LIMITS,
          connectionEnabled: salt !== undefined,
        });
      },
      createServer: (authInfo) => {
        const { subject } = authInfo.extra ?? {};
        return createBusServer({
          ...registry.forUser(UserIdSchema.parse(subject)),
          checkoutBaseUrl: baseUrl,
          connectionUrl: new URL("/connect", baseUrl).href,
          limits: config.MCP_LIMITS,
          connectionEnabled: salt !== undefined,
        });
      },
      publicHandlers: [
        (request) => oauth.handle(request),
        connection,
        (request) => registry.checkout(request),
      ],
      allowedHosts: config.MCP_ALLOWED_HOSTS.split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      allowedOrigins: [
        ...config.MCP_ALLOWED_ORIGINS.split(",")
          .map((value) => value.trim())
          .filter(Boolean),
        baseUrl.hostname,
      ],
    });
    const tokenStore = tokens;
    return {
      fetch,
      tick: () => registry.tick(),
      nextWakeAt: () => registry.nextWakeAt(),
      close: async () => {
        await registry.close();
        tokenStore.close();
        users.close();
      },
    };
  } catch (error) {
    await tenants?.close();
    tokens?.close();
    users.close();
    throw error;
  }
}
