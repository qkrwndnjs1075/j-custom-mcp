import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { ConnectionBrowser, connectionFixture, origin } from "./connection-fixtures";

const fixtures: ReturnType<typeof connectionFixture>[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});
function setup() {
  const fixture = connectionFixture();
  fixtures.push(fixture);
  return fixture;
}

test("connection pages preserve same-origin browser form origins without cross-origin referrers", async () => {
  const fixture = setup();
  const response = await fixture.request("/connect");
  expect(response.headers.get("referrer-policy")).toBe("same-origin");
});

test("two browser connections issue OAuth tokens for their own verified GO members and isolate disconnect", async () => {
  const fixture = setup();
  const clientId = await fixture.register();
  const first = await fixture.authorize(clientId);
  const second = await fixture.authorize(clientId);
  const alice = new ConnectionBrowser(fixture);
  const bob = new ConnectionBrowser(fixture);
  await alice.open(first.path);
  await bob.open(second.path);
  expect(alice.cookie).not.toBe(bob.cookie);
  await alice.connect();
  await bob.connect("01033334444");
  const connectedPage = await fixture.request("/connect", { headers: { cookie: alice.cookie } });
  expect(connectedPage.headers.get("content-security-policy")).toContain(
    "form-action 'self' https://client.example",
  );
  const a = await fixture.exchange(
    clientId,
    first.verifier,
    await alice.post("/connect/authorize"),
  );
  const b = await fixture.exchange(clientId, second.verifier, await bob.post("/connect/authorize"));
  const subjectSchema = z.object({ subject: z.string() });
  const aliceAuth = subjectSchema.parse(
    (await fixture.oauth.verifier.verifyAccessToken(a.access_token)).extra,
  );
  const bobAuth = subjectSchema.parse(
    (await fixture.oauth.verifier.verifyAccessToken(b.access_token)).extra,
  );
  expect(aliceAuth.subject).not.toBe(bobAuth.subject);
  const ids = fixture.users.list();
  const aliceUser = ids.find((value) => value.userId === aliceAuth.subject);
  const bobUser = ids.find((value) => value.userId === bobAuth.subject);
  if (!aliceUser || !bobUser) throw new TypeError("Missing verified users");
  expect(fixture.users.read(aliceUser.userId).credentials.moappMbrsSno).toBe("synthetic-alice");
  expect(fixture.users.read(bobUser.userId).credentials.moappMbrsSno).toBe("synthetic-bob");
  for (const page of [...alice.pages, ...bob.pages]) {
    for (const value of [
      "Synthetic Person",
      "01011112222",
      "01033334444",
      "19930317",
      "synthetic-auth-token",
      "synthetic-refreshed-token",
      "synthetic-billing-reference",
      "synthetic-alice",
      "synthetic-bob",
      "tx-",
    ])
      expect(page).not.toContain(value);
  }
  expect((await alice.post("/connect/disconnect")).status).toBe(303);
  await expect(fixture.oauth.verifier.verifyAccessToken(a.access_token)).rejects.toThrow();
  expect((await fixture.oauth.verifier.verifyAccessToken(b.access_token)).extra).toEqual(bobAuth);
  expect(fixture.users.status(aliceUser.userId)?.connected).toBe(false);
  expect(fixture.users.status(bobUser.userId)?.connected).toBe(true);
});

test.each(["origin", "csrf", "duplicate", "oversize", "unknown", "malformed"] as const)(
  "rejects %s browser form before upstream authentication",
  async (attack) => {
    const fixture = setup();
    const browser = new ConnectionBrowser(fixture);
    await browser.open();
    await browser.consent();
    const body = new URLSearchParams({
      csrf: browser.csrf,
      userName: "Synthetic Person",
      userPhone: "01011112222",
      userBirthday: "19930317",
    });
    if (attack === "csrf") body.set("csrf", "a".repeat(43));
    if (attack === "duplicate") body.append("userPhone", "01033334444");
    if (attack === "oversize") body.set("userName", "x".repeat(9000));
    if (attack === "unknown") body.append("userId", crypto.randomUUID());
    if (attack === "malformed") body.set("userPhone", "not-a-phone");
    const response = await fixture.request("/connect/start", {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: attack === "origin" ? "https://attacker.example" : origin,
      },
      body,
    });
    expect(response.status).toBe(attack === "origin" || attack === "csrf" ? 403 : 400);
    expect(fixture.state.starts).toBe(0);
    expect(fixture.users.list()).toHaveLength(0);
  },
);

test.each(["start", "finish"] as const)(
  "serializes concurrent browser %s submissions into one upstream call",
  async (stage) => {
    const fixture = setup();
    const browser = new ConnectionBrowser(fixture);
    await browser.open();
    await browser.consent();
    if (stage === "finish") await browser.start();
    const began = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    if (stage === "start") {
      fixture.state.startGate = gate.promise;
      fixture.state.onStart = began.resolve;
    } else {
      fixture.state.finishGate = gate.promise;
      fixture.state.onFinish = began.resolve;
    }
    const first = stage === "start" ? browser.start() : browser.finish();
    await began.promise;
    const second = stage === "start" ? await browser.start() : await browser.finish();
    expect(second.status).toBe(409);
    gate.resolve();
    expect((await first).status).toBe(303);
    expect(stage === "start" ? fixture.state.starts : fixture.state.finishes).toBe(1);
  },
);

test("does not persist credentials from an authentication response after browser flow expiry", async () => {
  const fixture = setup();
  const browser = new ConnectionBrowser(fixture);
  await browser.open();
  await browser.consent();
  await browser.start();
  const began = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  fixture.state.finishGate = gate.promise;
  fixture.state.onFinish = began.resolve;
  const pending = browser.finish();
  await began.promise;
  fixture.state.now += 900_001;
  gate.resolve();
  expect((await pending).status).toBe(410);
  expect(fixture.users.list()).toHaveLength(0);
});

test("a previous browser cannot disconnect a reconnected account", async () => {
  const fixture = setup();
  const old = new ConnectionBrowser(fixture);
  const current = new ConnectionBrowser(fixture);
  await old.open();
  await old.connect();
  const before = fixture.users.list()[0];
  if (!before) throw new TypeError("Missing user");
  await current.open();
  await current.connect();
  expect(fixture.users.status(before.userId)?.connectionId).not.toBe(before.connectionId);
  expect((await old.post("/connect/disconnect")).status).toBe(410);
  expect(fixture.users.status(before.userId)?.connected).toBe(true);
  expect((await current.post("/connect/disconnect")).status).toBe(303);
  expect(fixture.users.status(before.userId)?.connected).toBe(false);
});

test("disconnect revokes every OAuth grant family for the account", async () => {
  const fixture = setup();
  const clientId = await fixture.register();
  const pairs: { readonly access_token: string; readonly refresh_token: string }[] = [];
  let current: ConnectionBrowser | undefined;
  for (let index = 0; index < 2; index++) {
    const authorization = await fixture.authorize(clientId);
    const browser = new ConnectionBrowser(fixture);
    await browser.open(authorization.path);
    await browser.connect();
    pairs.push(
      await fixture.exchange(
        clientId,
        authorization.verifier,
        await browser.post("/connect/authorize"),
      ),
    );
    current = browser;
  }
  if (!current) throw new TypeError("Missing browser");
  expect(fixture.users.list()).toHaveLength(1);
  expect((await current.post("/connect/disconnect")).status).toBe(303);
  for (const pair of pairs) {
    await expect(fixture.oauth.verifier.verifyAccessToken(pair.access_token)).rejects.toThrow();
    const refresh = await fixture.request("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: pair.refresh_token,
        client_id: clientId,
        resource: `${origin}/mcp`,
      }),
    });
    expect(refresh.status).toBe(400);
  }
});
