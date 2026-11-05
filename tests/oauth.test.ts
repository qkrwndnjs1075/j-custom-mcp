import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AuthTokenStore } from "../src/auth-token-store";
import { OAuthAuthorizationHandle, OAuthService } from "../src/oauth-service";
import { oauthDigest, oauthSecret } from "../src/oauth-types";
import { UserIdSchema } from "../src/user-types";

const resource = "https://mcp.example/mcp";
const accountResource = "https://mcp.example/mcp/account";
const redirect = "https://client.example/callback?tenant=one";
const userA = UserIdSchema.parse(crypto.randomUUID());
const userB = UserIdSchema.parse(crypto.randomUUID());
const pairSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
});
let directory: string;
let store: AuthTokenStore;
let service: OAuthService;
let server: ReturnType<typeof Bun.serve>;
let now: number;
function restart() {
  store = new AuthTokenStore(join(directory, "oauth.sqlite"));
  service = new OAuthService({
    issuerUrl: "https://mcp.example",
    resourceUrl: resource,
    additionalResourceUrls: [accountResource],
    store,
    now: () => now,
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "oauth-test-"));
  now = 1800000000;
  restart();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      (await service.handle(request)) ?? new Response(null, { status: 404 }),
  });
});
afterEach(() => {
  server.stop(true);
  store.close();
  rmSync(directory, { recursive: true });
});
async function post(path: string, values: Record<string, string>) {
  return fetch(new URL(path, server.url), {
    method: "POST",
    body: new URLSearchParams(values),
    redirect: "manual",
  });
}
async function client() {
  const response = await fetch(new URL("/oauth/register", server.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Synthetic client", redirect_uris: [redirect] }),
  });
  expect(response.status).toBe(201);
  return z.object({ client_id: z.string() }).parse(await response.json()).client_id;
}
async function pending(clientId: string, overrides: Record<string, string> = {}) {
  const verifier = oauthSecret();
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "code",
    resource,
    scope: "mcp",
    state: "opaque-state",
    code_challenge: oauthDigest(verifier),
    code_challenge_method: "S256",
    ...overrides,
  });
  const response = await fetch(new URL(`/oauth/authorize?${query}`, server.url), {
    redirect: "manual",
  });
  return { response, verifier };
}
async function authorization(clientId: string, user = userA, selectedResource = resource) {
  const { response, verifier } = await pending(clientId, { resource: selectedResource });
  expect(response.status).toBe(302);
  const id =
    new URL(response.headers.get("location") ?? "").searchParams.get("authorization") ?? "";
  const binding = oauthSecret();
  const view = service.getAuthorization(id, binding);
  expect(new URL(view.restartUrl).searchParams.get("resource")).toBe(selectedResource);
  expect(view.redirectUri).toBe(redirect);
  expect(view.scope).toBe("mcp");
  expect(Object.isFrozen(view)).toBe(true);
  expect(() => service.getAuthorization(id, oauthSecret())).toThrow("invalid_request");
  expect(() => service.completeAuthorization(new OAuthAuthorizationHandle(), user)).toThrow(
    "invalid_request",
  );
  const callback = new URL(
    service.completeAuthorization(view.handle, user).headers.get("location") ?? "",
  );
  expect(callback.searchParams.get("state")).toBe("opaque-state");
  expect(callback.searchParams.get("iss")).toBe("https://mcp.example");
  expect(() => service.completeAuthorization(view.handle, user)).toThrow("invalid_request");
  return {
    grant_type: "authorization_code",
    client_id: clientId,
    resource: selectedResource,
    redirect_uri: redirect,
    code_verifier: verifier,
    code: callback.searchParams.get("code") ?? "",
  };
}
async function issue(clientId: string, user = userA, selectedResource = resource) {
  const input = await authorization(clientId, user, selectedResource);
  const response = await post("/oauth/token", input);
  expect(response.status).toBe(200);
  return pairSchema.parse(await response.json());
}
test("HTTP discovery advertises exact resource, issuer and S256", async () => {
  const metadata = await fetch(new URL("/.well-known/oauth-authorization-server", server.url));
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({
    issuer: "https://mcp.example",
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
  const protectedResource = await fetch(
    new URL("/.well-known/oauth-protected-resource/mcp", server.url),
  );
  expect(protectedResource.status).toBe(200);
  expect(await protectedResource.json()).toMatchObject({
    resource,
    authorization_servers: ["https://mcp.example"],
  });
});

test("resource discovery distinguishes both exact resources and rejects metadata aliases", async () => {
  // Given
  const resources = [resource, accountResource];
  // When / Then
  for (const selected of resources) {
    const path = `/.well-known/oauth-protected-resource${new URL(selected).pathname}`;
    const response = await fetch(new URL(path, server.url));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: selected,
      authorization_servers: ["https://mcp.example"],
    });
    for (const suffix of ["/", "?alias=1", "/unknown"]) {
      expect((await fetch(new URL(`${path}${suffix}`, server.url))).status).toBe(404);
    }
  }
  expect((await fetch(new URL("/.well-known/oauth-protected-resource", server.url))).status).toBe(
    404,
  );
});

test("account resource code and refresh reject the old audience without consuming the valid grant", async () => {
  // Given
  const id = await client();
  const input = await authorization(id, userA, accountResource);
  // When / Then
  expect((await post("/oauth/token", { ...input, resource })).status).toBe(400);
  const exchanged = await post("/oauth/token", input);
  expect(exchanged.status).toBe(200);
  const pair = pairSchema.parse(await exchanged.json());
  await expect(service.verifier.verifyAccessToken(pair.access_token)).rejects.toThrow();
  expect(
    (await service.verifierForResource(accountResource).verifyAccessToken(pair.access_token)).extra,
  ).toMatchObject({ subject: userA });
  const refresh = {
    grant_type: "refresh_token",
    client_id: id,
    resource: accountResource,
    refresh_token: pair.refresh_token,
  };
  expect((await post("/oauth/token", { ...refresh, resource })).status).toBe(400);
  const refreshed = await post("/oauth/token", refresh);
  expect(refreshed.status).toBe(200);
  const next = pairSchema.parse(await refreshed.json());
  expect(
    (await service.verifierForResource(accountResource).verifyAccessToken(next.access_token))
      .resource?.href,
  ).toBe(accountResource);
  await expect(service.verifier.verifyAccessToken(next.access_token)).rejects.toThrow();
});

test("per-resource verifiers reject cross-audience tokens and disconnect revokes both resources only for that user", async () => {
  // Given
  const id = await client();
  const old = await issue(id, userA);
  const account = await issue(id, userA, accountResource);
  const otherUser = await issue(id, userB, accountResource);
  const accountVerifier = service.verifierForResource(accountResource);
  // When / Then
  await expect(accountVerifier.verifyAccessToken(old.access_token)).rejects.toThrow();
  await expect(service.verifier.verifyAccessToken(account.access_token)).rejects.toThrow();
  expect(() => service.verifierForResource(`${accountResource}/`)).toThrow("invalid_request");
  expect(() => service.verifierForResource(`${accountResource}?alias=1`)).toThrow(
    "invalid_request",
  );
  service.disconnectUser(userA);
  await expect(service.verifier.verifyAccessToken(old.access_token)).rejects.toThrow();
  await expect(accountVerifier.verifyAccessToken(account.access_token)).rejects.toThrow();
  expect((await accountVerifier.verifyAccessToken(otherUser.access_token)).extra).toMatchObject({
    subject: userB,
  });
});

test.each([`${accountResource}/`, `${accountResource}?alias=1`, `${accountResource}/unknown`])(
  "rejects unregistered resource alias %s",
  async (selected) => {
    // Given
    const id = await client();
    // When
    const response = (await pending(id, { resource: selected })).response;
    // Then
    expect(response.status).toBe(400);
  },
);
test("HTTP authorization rejects redirect substitution, plain PKCE, missing resource and duplicate parameters", async () => {
  const id = await client();
  for (const overrides of [
    { redirect_uri: "https://evil.example/callback" },
    { code_challenge_method: "plain" },
    { resource: "" },
  ]) {
    expect((await pending(id, overrides)).response.status).toBe(400);
  }
  const response = await fetch(new URL("/oauth/authorize?client_id=a&client_id=b", server.url));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "invalid_request" });
});
test("HTTP code is bound to client, resource, redirect and S256 verifier; consumed once", async () => {
  const id = await client();
  const other = await client();
  const input = await authorization(id);
  for (const overrides of [
    { code_verifier: oauthSecret() },
    { client_id: other },
    { resource: "https://elsewhere.example/mcp" },
    { redirect_uri: "https://client.example/other" },
  ]) {
    expect((await post("/oauth/token", { ...input, ...overrides })).status).toBe(400);
  }
  const response = await post("/oauth/token", input);
  expect(response.status).toBe(200);
  const pair = pairSchema.parse(await response.json());
  expect((await service.verifier.verifyAccessToken(pair.access_token)).extra).toMatchObject({
    subject: userA,
  });
  expect((await post("/oauth/token", input)).status).toBe(400);
  const bytes = readFileSync(join(directory, "oauth.sqlite"));
  for (const secret of [input.code, pair.access_token, pair.refresh_token])
    expect(bytes.includes(Buffer.from(secret))).toBe(false);
  expect(statSync(join(directory, "oauth.sqlite")).mode & 0o777).toBe(0o600);
});
test("HTTP refresh rotates, replay revokes entire family and survives restart", async () => {
  const id = await client();
  const pair = await issue(id);
  const input = {
    grant_type: "refresh_token",
    client_id: id,
    resource,
    refresh_token: pair.refresh_token,
  };
  const response = await post("/oauth/token", input);
  expect(response.status).toBe(200);
  const rotated = pairSchema.parse(await response.json());
  expect(rotated.refresh_token).not.toBe(pair.refresh_token);
  expect((await post("/oauth/token", input)).status).toBe(400);
  store.close();
  restart();
  await expect(service.verifier.verifyAccessToken(rotated.access_token)).rejects.toThrow(
    "Authentication required",
  );
  expect(
    (await post("/oauth/token", { ...input, refresh_token: rotated.refresh_token })).status,
  ).toBe(400);
});
test("disconnect and HTTP revoke isolate users and verifier enforces expiry", async () => {
  const id = await client();
  const first = await issue(id);
  const second = await issue(id, userB);
  service.disconnectUser(userA);
  await expect(service.verifier.verifyAccessToken(first.access_token)).rejects.toThrow();
  expect((await service.verifier.verifyAccessToken(second.access_token)).extra).toMatchObject({
    subject: userB,
  });
  now += 3601;
  await expect(service.verifier.verifyAccessToken(second.access_token)).rejects.toThrow();
  const refreshed = await post("/oauth/token", {
    grant_type: "refresh_token",
    client_id: id,
    resource,
    refresh_token: second.refresh_token,
  });
  const pair = pairSchema.parse(await refreshed.json());
  expect((await post("/oauth/revoke", { token: pair.refresh_token, client_id: id })).status).toBe(
    200,
  );
  await expect(service.verifier.verifyAccessToken(pair.access_token)).rejects.toThrow();
});
test("disconnect invalidates unexchanged codes even after a new login for the same user", async () => {
  const id = await client();
  const oldCode = await authorization(id, userA);
  const unaffectedCode = await authorization(id, userB);
  service.disconnectUser(userA);
  const newlyAuthorized = await issue(id, userA);
  expect(
    (await service.verifier.verifyAccessToken(newlyAuthorized.access_token)).extra,
  ).toMatchObject({ subject: userA });
  const rejected = await post("/oauth/token", oldCode);
  expect(rejected.status).toBe(400);
  expect(await rejected.json()).toEqual({ error: "invalid_grant" });
  expect((await post("/oauth/token", unaffectedCode)).status).toBe(200);
});
test("authorization and code expire, malformed and oversized requests reveal only fixed errors", async () => {
  const id = await client();
  const { response } = await pending(id);
  const pendingId =
    new URL(response.headers.get("location") ?? "").searchParams.get("authorization") ?? "";
  now += 601;
  expect(() => service.getAuthorization(pendingId, oauthSecret())).toThrow("invalid_request");
  const input = await authorization(id);
  now += 121;
  expect((await post("/oauth/token", input)).status).toBe(400);
  for (const body of ["{secret-broken-json", "a".repeat(17000)]) {
    const result = await fetch(new URL("/oauth/register", server.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({ error: "invalid_request" });
  }
});
