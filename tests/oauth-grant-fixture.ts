import type { AuthTokenStore } from "../src/auth-token-store";
import { oauthDigest, oauthSecret } from "../src/oauth-types";
import type { UserId } from "../src/user-types";

export function oauthGrantFixture(tokens: AuthTokenStore, resource = "https://mcp.example/mcp") {
  const now = Math.floor(Date.now() / 1000);
  const clientId = crypto.randomUUID();
  const redirect = "https://client.example/callback";
  tokens.requests.register({
    client_id: clientId,
    client_name: "Synthetic VOOY",
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  });
  return (userId: UserId) => {
    const verifier = oauthSecret();
    const binding = oauthSecret();
    const pending = tokens.requests.createPending(
      {
        clientId,
        redirectUri: redirect,
        resource,
        challenge: oauthDigest(verifier),
        scope: "mcp",
        state: "synthetic",
        expiresAt: now + 600,
      },
      now,
    );
    tokens.requests.claim(pending, binding, now);
    const { code } = tokens.requests.complete(pending, binding, userId, now);
    return tokens.exchangeCode({ code, clientId, redirectUri: redirect, resource, verifier }, now);
  };
}
