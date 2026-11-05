import { z } from "zod";
import type { AuthTokenStore } from "./auth-token-store";
import { OAuthClientSchema, OAuthServiceError, oauthParse, oauthRedirect } from "./oauth-types";

export function oauthJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}
async function bodyText(request: Request): Promise<string> {
  if (!request.body) throw new OAuthServiceError("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new OAuthServiceError("invalid_request");
      }
      chunks.push(part.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
type Parameters = Record<string, string> & {
  readonly token?: string;
  readonly client_id?: string;
  readonly grant_type?: string;
};
function parameters(params: URLSearchParams): Parameters {
  const result: Parameters = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key) || value.length > 2048)
      throw new OAuthServiceError("invalid_request");
    Object.defineProperty(result, key, { value, enumerable: true });
  }
  return result;
}
const authSchema = z.object({
  client_id: z.string().uuid(),
  redirect_uri: z.string().url(),
  response_type: z.literal("code"),
  resource: z.string().url(),
  scope: z.literal("mcp").default("mcp"),
  state: z.string().max(2048).default(""),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code_challenge_method: z.literal("S256"),
});
const codeSchema = z.object({
  client_id: z.string().uuid(),
  code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  redirect_uri: z.string().url(),
  resource: z.string().url(),
  code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
});
const refreshSchema = z.object({
  client_id: z.string().uuid(),
  refresh_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  resource: z.string().url(),
  scope: z.literal("mcp").optional(),
});

export class OAuthEndpoints {
  constructor(
    readonly store: AuthTokenStore,
    readonly issuer: string,
    readonly resources: readonly string[],
    readonly loginPath: string,
    readonly now: () => number,
  ) {}

  async handle(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (
      !["/oauth/register", "/oauth/authorize", "/oauth/token", "/oauth/revoke"].includes(
        url.pathname,
      )
    )
      return undefined;
    const method = url.pathname === "/oauth/authorize" ? "GET" : "POST";
    if (request.method !== method)
      return new Response(null, { status: 405, headers: { Allow: method } });
    try {
      if (url.pathname === "/oauth/authorize") return this.#authorize(parameters(url.searchParams));
      const text = await bodyText(request);
      const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
      if (url.pathname === "/oauth/register") {
        if (contentType !== "application/json") throw new OAuthServiceError("invalid_request");
        const raw: unknown = JSON.parse(text);
        const client = oauthParse(
          OAuthClientSchema.unwrap()
            .omit({ client_id: true })
            .extend({
              client_name: z.string().min(1).max(120).default("MCP client"),
              token_endpoint_auth_method: z.literal("none").default("none"),
              grant_types: z
                .array(z.enum(["authorization_code", "refresh_token"]))
                .default(["authorization_code", "refresh_token"]),
              response_types: z.tuple([z.literal("code")]).default(["code"]),
            }),
          raw,
        );
        if (!client.grant_types.includes("authorization_code"))
          throw new OAuthServiceError("invalid_request");
        for (const redirect of client.redirect_uris) oauthRedirect(redirect);
        const registered = { ...client, client_id: crypto.randomUUID() };
        this.store.requests.register(registered);
        return oauthJson(registered, 201);
      }
      if (contentType !== "application/x-www-form-urlencoded")
        throw new OAuthServiceError("invalid_request");
      const form = parameters(new URLSearchParams(text));
      if (url.pathname === "/oauth/revoke") {
        const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(
          request.headers.get("authorization") ?? "",
        )?.[1];
        const token = z
          .string()
          .regex(/^[A-Za-z0-9_-]{43}$/)
          .safeParse(form.token ?? bearer);
        if (!token.success) throw new OAuthServiceError("invalid_request");
        this.store.revoke(token.data, form.client_id);
        return oauthJson({});
      }
      switch (form.grant_type) {
        case "authorization_code": {
          const input = oauthParse(codeSchema, form);
          if (!this.resources.includes(input.resource))
            throw new OAuthServiceError("invalid_grant");
          this.store.requests.client(input.client_id);
          return oauthJson(
            this.store.exchangeCode(
              {
                code: input.code,
                clientId: input.client_id,
                redirectUri: input.redirect_uri,
                resource: input.resource,
                verifier: input.code_verifier,
              },
              this.now(),
            ),
          );
        }
        case "refresh_token": {
          const input = oauthParse(refreshSchema, form);
          const client = this.store.requests.client(input.client_id);
          if (
            !this.resources.includes(input.resource) ||
            !client.grant_types.includes("refresh_token")
          )
            throw new OAuthServiceError("invalid_grant");
          return oauthJson(
            this.store.rotate(input.refresh_token, input.client_id, input.resource, this.now()),
          );
        }
        default:
          throw new OAuthServiceError("unsupported_grant_type");
      }
    } catch (error) {
      const code =
        error instanceof OAuthServiceError
          ? error.code
          : error instanceof SyntaxError
            ? "invalid_request"
            : "temporarily_unavailable";
      return oauthJson({ error: code }, code === "temporarily_unavailable" ? 503 : 400);
    }
  }

  #authorize(raw: unknown): Response {
    const input = oauthParse(authSchema, raw);
    const client = this.store.requests.client(input.client_id);
    if (
      !this.resources.includes(input.resource) ||
      !client.redirect_uris.includes(input.redirect_uri)
    )
      throw new OAuthServiceError("invalid_request");
    const pending = this.store.requests.createPending(
      {
        clientId: input.client_id,
        redirectUri: input.redirect_uri,
        resource: input.resource,
        challenge: input.code_challenge,
        scope: input.scope,
        state: input.state,
        expiresAt: this.now() + 600,
      },
      this.now(),
    );
    const login = new URL(this.loginPath, this.issuer);
    login.searchParams.set("authorization", pending);
    return new Response(null, {
      status: 302,
      headers: {
        Location: login.href,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
}
