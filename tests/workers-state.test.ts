import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AuthTokenStore } from "../src/auth-token-store";
import { CancellationService } from "../src/cancellation-service";
import { createConnectionHandler } from "../src/connection-http";
import { ConnectionSessions } from "../src/connection-sessions";
import { GoAuthError } from "../src/go-auth-types";
import { OAuthAuthorizationHandle, OAuthService } from "../src/oauth-service";
import { oauthDigest, oauthSecret } from "../src/oauth-types";
import { TossAppSchemeSchema } from "../src/toss-launch";
import type { StateStorage } from "../src/transient-state";
import { TripReferences } from "../src/trip-references";
import { UserCredentialStore } from "../src/user-credentials";
import { UserIdSchema } from "../src/user-types";
import { webTrip } from "./booking-fixtures";
import { serviceFixture } from "./cancellation-service-fixtures";
import { connectionFixture, origin } from "./connection-fixtures";
import { now as ticketTime } from "./go-ticket-fixtures";

class JsonState implements StateStorage {
  readonly values = new Map<string, string>();
  get(key: string): unknown {
    const value = this.values.get(key);
    return value === undefined ? undefined : JSON.parse(value);
  }
  set(key: string, value: unknown): void {
    this.values.set(key, JSON.stringify(value));
  }
  delete(key: string): void {
    this.values.delete(key);
  }
}

test("browser CSRF and rate budgets survive construction and reject interrupted requests", () => {
  const state = new JsonState();
  const first = new ConnectionSessions(() => 1800000000000, state);
  const { token, session } = first.create();
  const oldCsrf = session.csrf;
  first.rotate(session);
  first.chargeStart(session);
  first.chargeStart(session);
  first.chargeStart(session);
  const restarted = new ConnectionSessions(() => 1800000000000, state);
  const restored = restarted.get(token);
  expect(restored).toBeDefined();
  if (!restored) throw new Error("Missing session");
  expect(() => restarted.csrf(restored, oldCsrf)).toThrow("csrf");
  expect(() => restarted.csrf(restored, session.csrf)).not.toThrow();
  expect(() => restarted.chargeStart(restored)).toThrow("capacity");
  restored.busy = true;
  restarted.checkpoint();
  const interrupted = new ConnectionSessions(() => 1800000000000, state).get(token);
  expect(interrupted?.phase).toBe("error");
  expect(interrupted?.busy).toBe(false);
  expect(interrupted?.csrf).not.toBe(restored.csrf);
  expect(new ConnectionSessions(() => 1800000900000, state).get(token)).toBeUndefined();
  expect(new ConnectionSessions(() => 1800000000000, new JsonState()).get(token)).toBeUndefined();
});

test("global start budget cannot be reset by constructing a new session manager", () => {
  const state = new JsonState();
  const first = new ConnectionSessions(() => 1800000000000, state);
  for (let count = 0; count < 20; count++) first.chargeStart(first.create().session);
  const restarted = new ConnectionSessions(() => 1800000000000, state);
  expect(() => restarted.chargeStart(restarted.create().session)).toThrow("capacity");
});

test("updated trip quotes survive reconstruction without extending TTL or crossing storage scope", () => {
  const state = new JsonState();
  const first = new TripReferences(() => 1000, undefined, state);
  const reference = first.add(webTrip);
  first.updateQuote(reference, { ...webTrip, remainingSeats: 7 });
  const restored = new TripReferences(() => 2000, undefined, state);
  expect(restored.get(reference)?.remainingSeats).toBe(7);
  expect(new TripReferences(() => 2000, undefined, new JsonState()).get(reference)).toBeUndefined();
  expect(new TripReferences(() => 901000, undefined, state).get(reference)).toBeUndefined();
});

test("pending OAuth authorization survives service and session reconstruction but cannot be forged or reused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "oauth-state-"));
  const path = join(directory, "oauth.sqlite");
  let store = new AuthTokenStore(path);
  let now = 1800000000;
  const create = () =>
    new OAuthService({
      issuerUrl: "https://mcp.example",
      resourceUrl: "https://mcp.example/mcp",
      store,
      now: () => now,
    });
  try {
    const service = create();
    const registered = await service.handle(
      new Request("https://mcp.example/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "State test",
          redirect_uris: ["https://client.example/callback"],
        }),
      }),
    );
    if (!registered) throw new Error("Missing registration");
    const client = z.object({ client_id: z.string() }).parse(await registered.json());
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      resource: "https://mcp.example/mcp",
      scope: "mcp",
      state: "test-state",
      code_challenge: oauthDigest(oauthSecret()),
      code_challenge_method: "S256",
    });
    const response = await service.handle(
      new Request(`https://mcp.example/oauth/authorize?${query}`),
    );
    const pending = new URL(response?.headers.get("location") ?? "").searchParams.get(
      "authorization",
    );
    if (!pending) throw new Error("Missing authorization");
    const state = new JsonState();
    const sessions = new ConnectionSessions(() => now * 1000, state, service);
    const { token, session } = sessions.create();
    session.oauth = service.getAuthorization(pending, token);
    sessions.checkpoint();
    store.close();
    store = new AuthTokenStore(path);
    const restarted = create();
    const restored = new ConnectionSessions(() => now * 1000, state, restarted).get(token)?.oauth;
    if (!restored) throw new Error("Missing restored authorization");
    const user = UserIdSchema.parse(crypto.randomUUID());
    expect(() => restarted.completeAuthorization(new OAuthAuthorizationHandle(), user)).toThrow();
    expect(restarted.completeAuthorization(restored.handle, user).status).toBe(302);
    expect(() => restarted.completeAuthorization(restored.handle, user)).toThrow();
    now += 1000;
    const expiredSessions = new ConnectionSessions(() => now * 1000, state, create());
    expect(expiredSessions.get(token)).toBeUndefined();
    expect(expiredSessions.restartUrl(token)).toContain("/oauth/authorize?");
    expiredSessions.checkpoint();
  } finally {
    store.close();
    rmSync(directory, { recursive: true });
  }
});

test("ticket references survive reconstruction and still reject expiry and changed account bindings", async () => {
  await using item = serviceFixture("express");
  const state = new JsonState();
  let now = ticketTime;
  const options = {
    store: item.store,
    credentials: new UserCredentialStore(item.users, item.user.userId),
    client: item.native.client,
    now: () => now,
    state,
  };
  const first = new CancellationService(options);
  const ticket = (await first.listTickets("express")).tickets[0];
  if (!ticket) throw new Error("Missing ticket");
  const restored = new CancellationService(options);
  expect((await restored.quote(ticket.ticketRef, { mode: "all" })).quoteRef).toBeString();
  await expect(
    new CancellationService({ ...options, state: new JsonState() }).quote(ticket.ticketRef, {
      mode: "all",
    }),
  ).rejects.toThrow("invalid_reference");
  item.users.connect(item.input);
  await expect(restored.quote(ticket.ticketRef, { mode: "all" })).rejects.toThrow(
    "account_changed",
  );
  now += 900000;
  await expect(
    new CancellationService(options).quote(ticket.ticketRef, { mode: "all" }),
  ).rejects.toThrow("expired");
});

test("HTTP handler checkpoints consent, challenge and finish budget across every request restart", async () => {
  const item = connectionFixture();
  const state = new JsonState();
  let finishes = 0;
  const options = {
    baseUrl: new URL(origin),
    users: item.users,
    oauth: item.oauth,
    state,
    now: () => item.state.now,
    osVer: "34",
    disconnect: async () => {},
    auth: {
      start: async () => ({
        txId: "synthetic",
        reqSno: "synthetic",
        moappMbrsSno: "synthetic",
        appScheme: TossAppSchemeSchema.parse("supertoss://toss-cert/test"),
      }),
      finish: async () => {
        finishes++;
        throw new GoAuthError("verification_unconfirmed");
      },
    },
  };
  try {
    const first = await createConnectionHandler(options)(new Request(`${origin}/connect`));
    if (!first) throw new Error("Missing connection page");
    const cookie = first.headers.get("set-cookie")?.split(";")[0] ?? "";
    let csrf = /name="csrf" value="([^"]+)"/.exec(await first.text())?.[1] ?? "";
    const post = (path: string, fields: Record<string, string> = {}) =>
      createConnectionHandler(options)(
        new Request(`${origin}${path}`, {
          method: "POST",
          headers: { cookie, origin },
          body: new URLSearchParams({ csrf, ...fields }),
        }),
      );
    const refresh = async () => {
      const page = await createConnectionHandler(options)(
        new Request(`${origin}/connect`, { headers: { cookie } }),
      );
      csrf = /name="csrf" value="([^"]+)"/.exec((await page?.text()) ?? "")?.[1] ?? "";
    };
    expect((await post("/connect/consent", { goTerms: "yes", accountAccess: "yes" }))?.status).toBe(
      303,
    );
    await refresh();
    expect(
      (
        await post("/connect/start", {
          userName: "Synthetic",
          userPhone: "01011112222",
          userBirthday: "19930317",
        })
      )?.status,
    ).toBe(303);
    await refresh();
    for (let count = 0; count < 5; count++)
      expect((await post("/connect/finish"))?.status).toBe(400);
    expect((await post("/connect/finish"))?.status).toBe(400);
    expect(finishes).toBe(5);
  } finally {
    item.close();
  }
});
