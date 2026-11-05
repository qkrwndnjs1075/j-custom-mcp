import { afterEach, expect, test } from "bun:test";
import { load } from "cheerio";
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

test("a stale finish submission recovers the connected OAuth flow without repeating authentication", async () => {
  const fixture = setup();
  const clientId = await fixture.register();
  const authorization = await fixture.authorize(clientId);
  const browser = new ConnectionBrowser(fixture);
  await browser.open(authorization.path);
  await browser.consent();
  await browser.start();
  const staleCsrf = browser.csrf;
  expect((await browser.finish()).status).toBe(303);
  const currentCsrf = browser.csrf;
  const users = fixture.users.list();
  const rejected = await browser.post("/connect/finish", { csrf: staleCsrf });
  expect(rejected.status).toBe(403);
  expect(rejected.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(rejected.headers.get("cache-control")).toBe("no-store");
  expect(rejected.headers.get("set-cookie")).toBeNull();
  const html = await rejected.text();
  const page = load(html);
  expect(page("h1").text()).toBe("요청을 처리하지 않았어요");
  expect(page("main a.button").attr("href")).toBe("/connect");
  expect(page("main a.button").text()).toBe("현재 연결 상태 확인하기");
  expect(page("form, input, script, meta[http-equiv=refresh]")).toHaveLength(0);
  expect(html).not.toContain(staleCsrf);
  expect(html).not.toContain(currentCsrf);
  expect(html).not.toContain("계정 연결이 완료되지 않았어요");
  expect(fixture.users.list()).toEqual(users);
  expect(fixture.state.starts).toBe(1);
  expect(fixture.state.finishes).toBe(1);
  expect((await browser.open(page("main a.button").attr("href"))).status).toBe(200);
  const connected = load(browser.pages.at(-1) ?? "");
  expect(connected("h1").text()).toBe("계정이 연결됐어요");
  expect(connected('form[action="/connect/authorize"]')).toHaveLength(1);
  expect(browser.csrf).toBe(currentCsrf);
  const grant = await fixture.exchange(
    clientId,
    authorization.verifier,
    await browser.post("/connect/authorize"),
  );
  expect((await fixture.oauth.verifier.verifyAccessToken(grant.access_token)).clientId).toBe(
    clientId,
  );
  expect(fixture.state.starts).toBe(1);
  expect(fixture.state.finishes).toBe(1);
});

test.each([
  { route: "finish", attack: "origin" },
  { route: "disconnect", attack: "origin" },
  { route: "authorize", attack: "origin" },
  { route: "finish", attack: "missing-csrf" },
  { route: "finish", attack: "content-type" },
])(
  "a rejected $attack $route submission preserves the connected flow with safe recovery",
  async ({ route, attack }) => {
    const fixture = setup();
    const clientId = await fixture.register();
    const authorization = await fixture.authorize(clientId);
    const browser = new ConnectionBrowser(fixture);
    await browser.open(authorization.path);
    await browser.connect();
    const currentCsrf = browser.csrf;
    const users = fixture.users.list();
    const rejected = await fixture.request(`/connect/${route}`, {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: attack === "origin" ? "https://attacker.example" : origin,
        ...(attack === "content-type" ? { "content-type": "application/json" } : {}),
      },
      body: new URLSearchParams(
        attack === "missing-csrf" ? { unexpected: "value" } : { csrf: currentCsrf },
      ),
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("location")).toBeNull();
    expect(rejected.headers.get("set-cookie")).toBeNull();
    const html = await rejected.text();
    const page = load(html);
    expect(page("main a.button").attr("href")).toBe("/connect");
    expect(page("form, input, script, meta[http-equiv=refresh]")).toHaveLength(0);
    expect(html).not.toContain(currentCsrf);
    expect(html).not.toContain("attacker.example");
    expect(fixture.users.list()).toEqual(users);
    await browser.open();
    expect(browser.csrf).toBe(currentCsrf);
    expect(load(browser.pages.at(-1) ?? "")('form[action="/connect/authorize"]')).toHaveLength(1);
    const grant = await fixture.exchange(
      clientId,
      authorization.verifier,
      await browser.post("/connect/authorize"),
    );
    expect((await fixture.oauth.verifier.verifyAccessToken(grant.access_token)).clientId).toBe(
      clientId,
    );
    expect(fixture.state.starts).toBe(1);
    expect(fixture.state.finishes).toBe(1);
  },
);

test("an invalid OAuth claim returns to the requesting service instead of starting standalone enrollment", async () => {
  // Given
  const fixture = setup();
  const browser = new ConnectionBrowser(fixture);
  // When
  const rejected = await browser.open(`/connect?authorization=${"a".repeat(43)}`);
  // Then
  expect(rejected.status).toBe(410);
  const page = load(browser.pages.at(-1) ?? "");
  expect(page("form, main a.button")).toHaveLength(0);
  expect(browser.csrf).toBe("");
  expect(fixture.state.starts).toBe(0);
});

test("a delayed start response after expiry recovers through GET with a fresh cookie", async () => {
  const fixture = setup();
  const browser = new ConnectionBrowser(fixture);
  await browser.open();
  await browser.consent();
  const oldCookie = browser.cookie;
  const began = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  fixture.state.startGate = gate.promise;
  fixture.state.onStart = began.resolve;
  const pending = browser.start();
  await began.promise;
  fixture.state.now += 900_001;
  gate.resolve();
  const rejected = await pending;
  expect(rejected.ok).toBe(false);
  const errorPage = await rejected.text();
  expect(errorPage).toContain('href="/connect"');
  expect(errorPage).not.toContain('action="/connect/restart"');
  expect(errorPage).not.toContain('name="csrf"');
  expect((await browser.open()).status).toBe(200);
  expect(browser.cookie).not.toBe(oldCookie);
  await browser.consent();
  expect(browser.pages.at(-1)).toContain('action="/connect/start"');
  expect(fixture.users.list()).toHaveLength(0);
});

test.each(["waiting", "connected"] as const)(
  "completes the requesting client's OAuth grant after expiry during %s",
  async (phase) => {
    // Given
    const fixture = setup();
    const clientId = await fixture.register();
    const authorization = await fixture.authorize(clientId);
    const browser = new ConnectionBrowser(fixture);
    await browser.open(authorization.path);
    await browser.consent();
    await browser.start();
    if (phase === "connected") await browser.finish();
    fixture.state.now += 600_001;
    // When
    const expired = await browser.post(
      phase === "waiting" ? "/connect/finish" : "/connect/authorize",
    );
    const page = load(await expired.text());
    const href = page("main a.button").attr("href");
    expect(href).toBeDefined();
    const restart = new URL(href ?? "", origin);
    expect(restart.pathname).toBe("/oauth/authorize");
    const request = await fixture.request(restart.pathname + restart.search);
    const location = new URL(request.headers.get("location") ?? "", origin);
    await browser.open(location.pathname + location.search);
    await browser.connect();
    const grant = await fixture.exchange(
      clientId,
      authorization.verifier,
      await browser.post("/connect/authorize"),
    );
    // Then
    expect(expired.status).toBe(410);
    expect(request.status).toBe(302);
    expect(location.pathname + location.search).not.toBe(authorization.path);
    expect(restart.origin).toBe(origin);
    expect((await fixture.oauth.verifier.verifyAccessToken(grant.access_token)).clientId).toBe(
      clientId,
    );
    const stale = new ConnectionBrowser(fixture);
    expect((await stale.open(authorization.path)).status).toBe(410);
  },
);

test.each([false, true])(
  "retains OAuth recovery after browser session expiry with reload=%s",
  async (reload) => {
    // Given
    const fixture = setup();
    const clientId = await fixture.register();
    const authorization = await fixture.authorize(clientId);
    const browser = new ConnectionBrowser(fixture);
    await browser.open(authorization.path);
    await browser.consent();
    await browser.start();
    fixture.state.now += 900_001;
    // When
    const expired = reload ? await browser.open() : await browser.finish();
    const page = load(reload ? (browser.pages.at(-1) ?? "") : await expired.text());
    const restart = new URL(page("main a.button").attr("href") ?? "", origin);
    const request = await fixture.request(restart.pathname + restart.search);
    const location = new URL(request.headers.get("location") ?? "", origin);
    await browser.open(location.pathname + location.search);
    await browser.connect();
    const grant = await fixture.exchange(
      clientId,
      authorization.verifier,
      await browser.post("/connect/authorize"),
    );
    // Then
    expect(expired.status).toBe(410);
    expect(restart.pathname).toBe("/oauth/authorize");
    expect((await fixture.oauth.verifier.verifyAccessToken(grant.access_token)).clientId).toBe(
      clientId,
    );
  },
);

test("a lost browser cookie cannot silently downgrade OAuth recovery to standalone enrollment", async () => {
  // Given
  const fixture = setup();
  const browser = new ConnectionBrowser(fixture);
  await browser.open((await fixture.authorize(await fixture.register())).path);
  await browser.consent();
  await browser.start();
  browser.cookie = "";
  // When
  const expired = await browser.finish();
  // Then
  const page = load(await expired.text());
  expect(expired.status).toBe(410);
  expect(page("form, main a.button")).toHaveLength(0);
  expect(fixture.users.list()).toHaveLength(0);
  expect(fixture.state.finishes).toBe(0);
});
