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

test("preserves each parallel browser's private start metadata through result confirmation", async () => {
  // Given
  const fixture = setup();
  const first = new ConnectionBrowser(fixture);
  const second = new ConnectionBrowser(fixture);
  await Promise.all([first.open(), second.open()]);
  await Promise.all([first.consent(), second.consent()]);
  await Promise.all([first.start("01011112222"), second.start("01033334444")]);
  // When
  await Promise.all([second.finish(), first.finish()]);
  // Then
  expect(fixture.state.startedChallenges).toHaveLength(2);
  expect(fixture.state.resultRequests).toHaveLength(2);
  expect(new Set(fixture.state.startedChallenges.map((item) => item.reqSno)).size).toBe(2);
  expect(new Set(fixture.state.startedChallenges.map((item) => item.moappMbrsSno)).size).toBe(2);
  for (const challenge of fixture.state.startedChallenges) {
    expect(
      fixture.state.resultRequests.find((item) => item.device === challenge.device)?.body,
    ).toEqual({
      txId: challenge.txId,
      reqSno: challenge.reqSno,
      moappMbrsSno: challenge.moappMbrsSno,
      encYn: "Y",
    });
    for (const page of [...first.pages, ...second.pages]) {
      expect(page).not.toContain(challenge.reqSno);
      expect(page).not.toContain(challenge.moappMbrsSno);
      expect(page).not.toContain('name="reqSno"');
      expect(page).not.toContain('name="moappMbrsSno"');
    }
  }
  expect(fixture.users.list()).toHaveLength(2);
});

test.each(["reqSno", "moappMbrsSno"] as const)(
  "rejects missing %s before presenting Toss waiting controls",
  async (field) => {
    // Given
    const fixture = setup();
    fixture.state.missingStartMetadata = field;
    const browser = new ConnectionBrowser(fixture);
    await browser.open();
    await browser.consent();
    // When
    const response = await browser.start();
    // Then
    expect(response.status).toBe(503);
    const page = load(await response.text());
    expect(page('a[href^="supertoss:"], form[action="/connect/finish"]')).toHaveLength(0);
    expect(fixture.state.resultRequests).toHaveLength(0);
    expect(fixture.users.list()).toHaveLength(0);
  },
);

test("waiting exposes the provider URI only in its browser and clears it after completion", async () => {
  // Given
  const fixture = setup();
  const browser = new ConnectionBrowser(fixture);
  await browser.open();
  await browser.consent();
  // When
  const started = await browser.start();
  // Then
  expect(started.status).toBe(303);
  expect(started.headers.get("location")).toBe("/connect");
  const waiting = load(browser.pages.at(-1) ?? "");
  const launch = waiting('a[href^="supertoss:"]');
  expect(launch).toHaveLength(1);
  expect(launch.attr("href")).toBe(fixture.state.appScheme);
  expect(launch.attr("rel")).toBe("noreferrer");
  expect(launch.attr("referrerpolicy")).toBe("no-referrer");
  const stranger = new ConnectionBrowser(fixture);
  await stranger.open();
  expect(load(stranger.pages.at(-1) ?? "")('a[href^="supertoss:"]')).toHaveLength(0);
  expect((await browser.finish()).status).toBe(303);
  expect(load(browser.pages.at(-1) ?? "")('a[href^="supertoss:"]')).toHaveLength(0);
  expect(fixture.users.list()).toHaveLength(1);
  expect(fixture.state.paymentInquiries).toBe(0);
});

test.each([
  undefined,
  "javascript:alert(1)",
  "supertoss://attacker.example/path",
  "supertoss://user@toss-cert/path",
  "supertoss://toss-cert/path\n",
])("rejects missing or unsafe launch URI case %# and permits restart", async (appScheme) => {
  // Given
  const fixture = setup();
  fixture.state.appScheme = appScheme;
  const browser = new ConnectionBrowser(fixture);
  await browser.open();
  await browser.consent();
  // When
  const response = await browser.start();
  // Then
  expect(response.status).toBe(503);
  const page = load(await response.text());
  expect(page('a[href^="supertoss:"], form[action="/connect/finish"]')).toHaveLength(0);
  expect(page('form[action="/connect/restart"]')).toHaveLength(1);
  expect(fixture.state.finishes).toBe(0);
  expect(fixture.users.list()).toHaveLength(0);
  expect((await browser.post("/connect/restart")).status).toBe(303);
  await browser.open();
  expect(load(browser.pages.at(-1) ?? "")('form[action="/connect/consent"]')).toHaveLength(1);
});

test.each(["restart", "error", "expiry"] as const)(
  "removes launch URI on %s",
  async (transition) => {
    // Given
    const fixture = setup();
    const browser = new ConnectionBrowser(fixture);
    await browser.open();
    await browser.consent();
    await browser.start();
    // When
    if (transition === "expiry") fixture.state.now += 900_001;
    else await browser.post(transition === "restart" ? "/connect/restart" : "/connect/unknown");
    await browser.open();
    // Then
    expect(
      load(browser.pages.at(-1) ?? "")('a[href^="supertoss:"], form[action="/connect/finish"]'),
    ).toHaveLength(0);
  },
);

test("does not accept provider query values as an authentication callback", async () => {
  // Given
  const fixture = setup();
  const browser = new ConnectionBrowser(fixture);
  await browser.open();
  await browser.consent();
  await browser.start();
  // When
  const response = await fixture.request("/connect?txId=untrusted&token=private-query-value", {
    headers: { cookie: browser.cookie },
  });
  // Then
  expect(response.status).toBe(400);
  const body = await response.text();
  expect(body).not.toContain("private-query-value");
  expect(load(body)('a[href^="supertoss:"], form[action="/connect/finish"]')).toHaveLength(0);
  expect(fixture.state.finishes).toBe(0);
});

test.each(["origin", "csrf", "expiry"] as const)(
  "rejects %s finish without upstream verification",
  async (attack) => {
    // Given
    const fixture = setup();
    const browser = new ConnectionBrowser(fixture);
    await browser.open();
    await browser.consent();
    await browser.start();
    if (attack === "expiry") fixture.state.now += 900_001;
    // When
    const response = await fixture.request("/connect/finish", {
      method: "POST",
      headers: {
        cookie: browser.cookie,
        origin: attack === "origin" ? "https://attacker.example" : origin,
      },
      body: new URLSearchParams({ csrf: attack === "csrf" ? "a".repeat(43) : browser.csrf }),
    });
    // Then
    expect(response.status).toBe(attack === "expiry" ? 410 : 403);
    expect(fixture.state.finishes).toBe(0);
    expect(fixture.users.list()).toHaveLength(0);
    expect(load(await response.text())('a[href^="supertoss:"]')).toHaveLength(0);
  },
);

test("retains retry when verification is unconfirmed without claiming approval is pending", async () => {
  // Given
  const fixture = setup();
  fixture.state.approved = false;
  const browser = new ConnectionBrowser(fixture);
  await browser.open();
  await browser.consent();
  await browser.start();
  // When
  const pending = await browser.finish();
  // Then
  expect(pending.status).toBe(400);
  const waiting = load(await pending.text());
  expect(waiting('[role="alert"]').text()).toBe(
    "인증 완료를 확인하지 못했어요. 토스에서 완료 여부를 확인한 뒤 다시 시도해 주세요.",
  );
  expect(waiting.text()).not.toContain("토스에서 인증을 완료한 뒤 다시 확인해 주세요.");
  expect(waiting('a[href^="supertoss:"]').attr("href")).toBe(fixture.state.appScheme);
  expect(waiting('form[action="/connect/finish"]')).toHaveLength(1);
  expect(fixture.users.list()).toHaveLength(0);
  fixture.state.approved = true;
  expect((await browser.finish()).status).toBe(303);
  expect(fixture.users.list()).toHaveLength(1);
  expect((await browser.post("/connect/disconnect")).status).toBe(303);
  await browser.open();
  expect(load(browser.pages.at(-1) ?? "")('a[href^="supertoss:"]')).toHaveLength(0);
});

test.each([
  {
    name: "authResult HTTP 401",
    resultHttpStatus: 401,
    refreshHttpStatus: 200,
    resultCode: "0000",
    resultFlag: "Y",
    calls: 1,
  },
  {
    name: "authResult HTTP 403",
    resultHttpStatus: 403,
    refreshHttpStatus: 200,
    resultCode: "0000",
    resultFlag: "Y",
    calls: 1,
  },
  {
    name: "unknown response code",
    resultHttpStatus: 200,
    refreshHttpStatus: 200,
    resultCode: "9999",
    resultFlag: "Y",
    calls: 1,
  },
  {
    name: "unknown verification flag",
    resultHttpStatus: 200,
    refreshHttpStatus: 200,
    resultCode: "0000",
    resultFlag: "UNKNOWN",
    calls: 1,
  },
  {
    name: "successful authResult then refresh HTTP 401",
    resultHttpStatus: 200,
    refreshHttpStatus: 401,
    resultCode: "0000",
    resultFlag: "Y",
    calls: 2,
  },
  {
    name: "successful authResult then refresh HTTP 403",
    resultHttpStatus: 200,
    refreshHttpStatus: 403,
    resultCode: "0000",
    resultFlag: "Y",
    calls: 2,
  },
])("renders a sanitized terminal failure for $name", async (scenario) => {
  // Given
  const fixture = setup();
  Object.assign(fixture.state, scenario);
  const browser = new ConnectionBrowser(fixture);
  await browser.open();
  await browser.consent();
  await browser.start();
  // When
  const response = await browser.finish();
  // Then
  expect(response.status).toBe(503);
  const body = await response.text();
  const page = load(body);
  expect(page('[role="alert"]').text()).toBe(
    "연결을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.",
  );
  expect(page('a[href^="supertoss:"], form[action="/connect/finish"]')).toHaveLength(0);
  expect(page('form[action="/connect/restart"]')).toHaveLength(1);
  expect(body).not.toContain("토스에서 인증을 완료한 뒤 다시 확인해 주세요.");
  expect(body).not.toContain("synthetic-private-error");
  expect(body).not.toContain("synthetic-auth-token");
  expect(body).not.toContain("synthetic-refreshed-token");
  expect(fixture.state.completionPaths).toEqual([
    "/api/mbrs/auth/v2/toss/authResult",
    ...(scenario.calls === 2 ? ["/api/mbrs/v2/uptMbrsAuthTknInfo"] : []),
  ]);
  expect(fixture.state.paymentInquiries).toBe(0);
  expect(fixture.users.list()).toHaveLength(0);
});
