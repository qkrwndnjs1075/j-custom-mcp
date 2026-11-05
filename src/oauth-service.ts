import {
  OAuthError,
  type OAuthMetadata,
  type OAuthTokenVerifier,
  oauthMetadataResponse,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AuthTokenStore } from "./auth-token-store";
import { OAuthEndpoints } from "./oauth-endpoints";
import { OAuthServiceError, oauthRedirect } from "./oauth-types";
import type { UserId } from "./user-types";

const authorizationSnapshot = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  binding: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
  clientName: z.string(),
  clientOrigin: z.string().url(),
  redirectUri: z.string().url(),
  scope: z.string(),
  expiresAt: z.number().finite(),
  restartUrl: z.string().url(),
});

export class OAuthAuthorizationHandle {}
export type OAuthAuthorizationView = {
  readonly clientName: string;
  readonly clientOrigin: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly restartUrl: string;
  readonly handle: OAuthAuthorizationHandle;
};
export class OAuthService {
  readonly #store: AuthTokenStore;
  readonly #now: () => number;
  readonly #issuer: string;
  readonly #resource: URL;
  readonly #resources: readonly URL[];
  readonly #verifiers = new Map<string, OAuthTokenVerifier>();
  readonly #metadata: OAuthMetadata;
  readonly #endpoints: OAuthEndpoints;
  readonly #handles = new WeakMap<
    OAuthAuthorizationHandle,
    { readonly id: string; readonly binding: string }
  >();
  readonly #snapshots = new WeakMap<
    OAuthAuthorizationHandle,
    { readonly id: string; readonly binding: string }
  >();
  readonly verifier: OAuthTokenVerifier;

  constructor(options: {
    readonly issuerUrl: string;
    readonly resourceUrl: string;
    readonly additionalResourceUrls?: readonly string[];
    readonly store: AuthTokenStore;
    readonly loginPath?: string;
    readonly now?: () => number;
    readonly allowLoopbackHttp?: boolean;
  }) {
    const endpoint = (value: string) => {
      const url = new URL(value);
      if (
        options.allowLoopbackHttp === true &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !url.username &&
        !url.password &&
        !url.hash
      )
        return url;
      return new URL(oauthRedirect(value));
    };
    const issuer = endpoint(options.issuerUrl);
    this.#resource = endpoint(options.resourceUrl);
    this.#resources = [this.#resource, ...(options.additionalResourceUrls ?? []).map(endpoint)];
    const loginPath = options.loginPath ?? "/connect";
    if (
      issuer.pathname !== "/" ||
      issuer.search ||
      this.#resources.some(
        (resource) =>
          issuer.origin !== resource.origin ||
          resource.search ||
          (resource.pathname !== "/" && resource.pathname.endsWith("/")),
      ) ||
      new Set(this.#resources.map((resource) => resource.href)).size !== this.#resources.length ||
      !/^\/[A-Za-z0-9/_-]*$/.test(loginPath) ||
      loginPath.startsWith("//")
    )
      throw new OAuthServiceError("invalid_request");
    this.#issuer = issuer.origin;
    this.#store = options.store;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#metadata = {
      issuer: this.#issuer,
      authorization_endpoint: `${this.#issuer}/oauth/authorize`,
      token_endpoint: `${this.#issuer}/oauth/token`,
      registration_endpoint: `${this.#issuer}/oauth/register`,
      revocation_endpoint: `${this.#issuer}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      scopes_supported: ["mcp"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
    };
    this.#endpoints = new OAuthEndpoints(
      options.store,
      this.#issuer,
      this.#resources.map((resource) => resource.href),
      loginPath,
      this.#now,
    );
    for (const resource of this.#resources)
      this.#verifiers.set(resource.href, {
        verifyAccessToken: async (token) => {
          try {
            return this.#store.verify(token, resource.href, this.#now());
          } catch (error) {
            if (error instanceof OAuthServiceError && error.code === "temporarily_unavailable")
              throw new OAuthError("server_error", "Authentication unavailable");
            throw new OAuthError("invalid_token", "Authentication required");
          }
        },
      });
    this.verifier = this.verifierForResource(this.#resource.href);
  }

  verifierForResource(resource: string): OAuthTokenVerifier {
    const verifier = this.#verifiers.get(resource);
    if (!verifier) throw new OAuthServiceError("invalid_request");
    return verifier;
  }

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    const resource = this.#resources.find(
      (candidate) =>
        url.pathname ===
        `/.well-known/oauth-protected-resource${candidate.pathname === "/" ? "" : candidate.pathname}`,
    );
    if (!url.search && (resource || url.pathname === "/.well-known/oauth-authorization-server"))
      return oauthMetadataResponse(request, {
        oauthMetadata: this.#metadata,
        resourceServerUrl: resource ?? this.#resource,
        scopesSupported: ["mcp"],
        resourceName: "Tmoney GO MCP",
      });
    return this.#endpoints.handle(request);
  }

  getAuthorization(pendingId: string, browserBinding: string): OAuthAuthorizationView {
    return this.#safe(() => {
      if (!/^[A-Za-z0-9_-]{43}$/.test(pendingId) || !/^[A-Za-z0-9_-]{43,128}$/.test(browserBinding))
        throw new OAuthServiceError("invalid_request");
      const pending = this.#store.requests.claim(pendingId, browserBinding, this.#now());
      const client = this.#store.requests.client(pending.clientId);
      const restart = new URL("/oauth/authorize", this.#issuer);
      restart.search = new URLSearchParams({
        client_id: pending.clientId,
        redirect_uri: pending.redirectUri,
        response_type: "code",
        resource: pending.resource,
        scope: pending.scope,
        state: pending.state,
        code_challenge: pending.challenge,
        code_challenge_method: "S256",
      }).toString();
      const handle = new OAuthAuthorizationHandle();
      this.#handles.set(handle, { id: pendingId, binding: browserBinding });
      this.#snapshots.set(handle, { id: pendingId, binding: browserBinding });
      return Object.freeze({
        clientName: client.client_name,
        clientOrigin: new URL(pending.redirectUri).origin,
        redirectUri: pending.redirectUri,
        scope: pending.scope,
        expiresAt: pending.expiresAt,
        restartUrl: restart.href,
        handle,
      });
    });
  }

  serializeAuthorization(view: OAuthAuthorizationView): unknown {
    const binding = this.#snapshots.get(view.handle);
    if (!binding) throw new OAuthServiceError("invalid_request");
    const { handle: _handle, ...metadata } = view;
    return { ...metadata, ...binding };
  }

  restoreAuthorization(value: unknown): OAuthAuthorizationView {
    const { id, binding, ...metadata } = authorizationSnapshot.parse(value);
    try {
      return this.getAuthorization(id, binding);
    } catch (error) {
      if (!(error instanceof OAuthServiceError) || error.code !== "invalid_request") throw error;
      const handle = new OAuthAuthorizationHandle();
      // Expired metadata can render a restart link, but cannot authorize an account.
      this.#snapshots.set(handle, { id, binding });
      return Object.freeze({ ...metadata, expiresAt: 0, handle });
    }
  }

  completeAuthorization(handle: OAuthAuthorizationHandle, userId: UserId): Response {
    return this.#safe(() => {
      const binding = this.#handles.get(handle);
      if (!binding) throw new OAuthServiceError("invalid_request");
      this.#handles.delete(handle);
      const result = this.#store.requests.complete(
        binding.id,
        binding.binding,
        userId,
        this.#now(),
      );
      const callback = new URL(result.pending.redirectUri);
      callback.searchParams.set("code", result.code);
      if (result.pending.state) callback.searchParams.set("state", result.pending.state);
      callback.searchParams.set("iss", this.#issuer);
      return new Response(null, {
        status: 302,
        headers: {
          Location: callback.href,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      });
    });
  }
  disconnectUser(userId: UserId): void {
    this.#store.disconnectUser(userId);
  }
  #safe<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof OAuthServiceError) throw error;
      throw new OAuthServiceError("temporarily_unavailable");
    }
  }
}
