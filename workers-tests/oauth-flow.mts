import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { type Harness, origin } from "./harness.mts";

export async function connect(item: Harness, phone: string, restart = false) {
  const registered = await item.request("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Synthetic workerd client",
      redirect_uris: ["https://client.example/callback"],
    }),
  });
  assert.equal(registered.status, 201, await registered.clone().text());
  const client = z.object({ client_id: z.string() }).parse(await registered.json());
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "https://client.example/callback",
    response_type: "code",
    resource: `${origin}/mcp`,
    scope: "mcp",
    state: "synthetic-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorization = await item.request(`/oauth/authorize?${query}`);
  assert.equal(authorization.status, 302);
  const entry = await item.request(authorization.headers.get("location") ?? "");
  assert.equal(entry.status, 303, await entry.clone().text());
  const cookie = entry.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  let csrf = "";
  const open = async () => {
    const page = await item.request("/connect", { headers: { cookie } });
    assert.equal(page.status, 200, await page.clone().text());
    const html = await page.text();
    assert.doesNotMatch(html, /synthetic-auth-token|synthetic-refreshed-token/);
    csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    assert.ok(csrf);
  };
  const post = (path: string, fields: Record<string, string> = {}) =>
    item.request(path, {
      method: "POST",
      headers: { cookie, origin },
      body: new URLSearchParams({ csrf, ...fields }),
    });
  await open();
  const consent = await post("/connect/consent", { goTerms: "yes", accountAccess: "yes" });
  assert.equal(consent.status, 303, await consent.clone().text());
  await open();
  const start = await post("/connect/start", {
    userName: "Synthetic Person",
    userPhone: phone,
    userBirthday: "19930317",
  });
  assert.equal(
    start.status,
    303,
    `${await start.clone().text()} ${JSON.stringify(item.unexpected)}`,
  );
  if (restart) await item.restart();
  await open();
  const finish = await post("/connect/finish");
  assert.equal(
    finish.status,
    303,
    `${await finish.clone().text()} ${JSON.stringify(item.unexpected)}`,
  );
  await open();
  if (restart) await item.restart();
  const completed = await post("/connect/authorize");
  assert.equal(completed.status, 302, await completed.clone().text());
  const callback = new URL(completed.headers.get("location") ?? "");
  assert.equal(callback.searchParams.get("state"), "synthetic-state");
  const exchange = await item.request("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      resource: `${origin}/mcp`,
      redirect_uri: "https://client.example/callback",
      code_verifier: verifier,
      code: callback.searchParams.get("code") ?? "",
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  return z
    .object({ access_token: z.string(), refresh_token: z.string() })
    .parse(await exchange.json());
}
