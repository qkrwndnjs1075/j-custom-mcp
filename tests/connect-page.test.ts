import { expect, test } from "bun:test";
import { load } from "cheerio";
import { CONNECTION_MESSAGES, renderConnectionPage } from "../src/connect-page";
import { CONNECTION_STYLES } from "../src/connection-styles";
import { GO_IDENTITY_TERMS_URL } from "../src/go-enroll";
import { TossAppSchemeSchema } from "../src/toss-launch";

const base = {
  csrf: 'synthetic-csrf-"<&',
  challenge: {
    appScheme: TossAppSchemeSchema.parse(
      'supertoss://toss-cert/v2/sign/user/auth/id?txId=synthetic&token="<&',
    ),
  },
  oauth: {
    clientName: "VOOY",
    clientOrigin: "https://example.invalid",
    redirectUri: "https://example.invalid/oauth/callback?one=1&two=2",
  },
};

for (const phase of [
  "consent",
  "identity",
  "waiting",
  "connected",
  "disconnected",
  "error",
] as const) {
  test(`${phase} renders semantic Korean SSR without executable or external resources`, () => {
    const $ = load(renderConnectionPage({ ...base, phase }));
    expect($("html").attr("lang")).toBe("ko");
    expect($("main h1")).toHaveLength(1);
    expect($("title").text()).toContain($("h1").text());
    expect($("script, iframe, img, style, [style]")).toHaveLength(0);
    expect($("link").attr("href")).toBe("/connect/style.css");
    for (const element of $("*").toArray()) {
      if ("attribs" in element)
        expect(Object.keys(element.attribs).some((name) => /^on/i.test(name))).toBe(false);
    }
    for (const form of $("form").toArray()) {
      expect($(form).attr("method")).toBe("post");
      expect($(form).attr("action")).toMatch(
        /^\/connect\/(consent|start|finish|disconnect|restart|authorize)$/,
      );
      const hidden = $(form).find('input[type="hidden"]');
      expect(hidden).toHaveLength(1);
      expect(hidden.attr("name")).toBe("csrf");
      expect(hidden.attr("value")).toBe(base.csrf);
    }
  });
}

test("consent exposes full client destination and requires two separate unchecked permissions", () => {
  const $ = load(renderConnectionPage({ ...base, phase: "consent" }));
  expect(
    $("dd")
      .map((_, element) => $(element).text())
      .get(),
  ).toEqual(Object.values(base.oauth));
  expect($("a.terms").attr("href")).toBe(GO_IDENTITY_TERMS_URL);
  expect($("a.terms").attr("rel")).toBe("noopener noreferrer");
  expect($("form").attr("action")).toBe("/connect/consent");
  for (const name of ["goTerms", "accountAccess"]) {
    const input = $(`input[name="${name}"]`);
    expect(input.attr("required")).toBeDefined();
    expect(input.attr("checked")).toBeUndefined();
    expect(input.attr("value")).toBe("yes");
  }
  expect($(".scope").text()).toContain("계정 연결만으로 결제하지 않아요");
  expect($(".scope").text()).toContain("최대 금액과 요청 유효시간");
  expect($(".scope").text()).toContain("자동 예매 요청 상태 조회");
  expect($("body").text()).not.toContain("예약 내역 조회");
  expect($(".brand").text()).toBe("버스 예매 도우미");
  expect($("footer").text()).toContain("외부 연결 서비스");
});

test("expired flow uses its supplied recovery destination without an empty-CSRF form", () => {
  const $ = load(
    renderConnectionPage({
      phase: "error",
      csrf: "",
      message: CONNECTION_MESSAGES.expired,
      restartUrl: "/connect",
    }),
  );
  expect($("form")).toHaveLength(0);
  expect($("main a.button").attr("href")).toBe("/connect");
  expect($("main a.button").text()).toBe("새 연결 시작하기");
  const valid = load(renderConnectionPage({ ...base, phase: "error" }));
  expect(valid('form[action="/connect/restart"]')).toHaveLength(1);
  const unknown = load(renderConnectionPage({ phase: "error", csrf: "" }));
  expect(unknown("form, main a.button")).toHaveLength(0);
});

test("identity provides labeled blank fields with explicit keyboard and autocomplete metadata", () => {
  const $ = load(renderConnectionPage({ ...base, phase: "identity" }));
  expect($("form").attr("action")).toBe("/connect/start");
  for (const [name, autocomplete] of [
    ["userName", "name"],
    ["userPhone", "tel-national"],
    ["userBirthday", "bday"],
  ]) {
    const input = $(`input[name="${name}"]`);
    expect(input.attr("value")).toBeUndefined();
    expect(input.attr("required")).toBeDefined();
    expect(input.attr("autocomplete")).toBe(autocomplete);
    expect($(`label[for="${name}"]`).text().length).toBeGreaterThan(0);
  }
  expect($("#userPhone").attr("inputmode")).toBe("tel");
  expect($("#userBirthday").attr("inputmode")).toBe("numeric");
  expect($("[aria-current=step]").text()).toContain("정보 입력");
});

test("waiting requires an explicit finish check after Toss and allows restart", () => {
  const $ = load(renderConnectionPage({ ...base, phase: "waiting" }));
  expect(
    $("form")
      .map((_, form) => $(form).attr("action"))
      .get(),
  ).toEqual(["/connect/finish", "/connect/restart"]);
  expect($('a[href^="supertoss:"]').attr("href")).toBe(base.challenge.appScheme);
  expect($('a[href^="supertoss:"]').attr("referrerpolicy")).toBe("no-referrer");
  expect($("script, img, [onerror]")).toHaveLength(0);
  expect($("meta[http-equiv=refresh], a[href^='toss:']")).toHaveLength(0);
});

test("connected separates account readiness from payment readiness and supports safe disconnection", () => {
  const connected = load(renderConnectionPage({ ...base, phase: "connected" }));
  expect(connected('form[action="/connect/authorize"]')).toHaveLength(1);
  expect(connected('a[href^="supertoss:"]')).toHaveLength(0);
  const $ = load(renderConnectionPage({ phase: "connected", csrf: base.csrf }));
  expect($('form[action="/connect/authorize"]')).toHaveLength(0);
  expect($('form[action="/connect/disconnect"]')).toHaveLength(1);
});

test("untrusted context is text and arbitrary provider errors are never reflected", () => {
  const attack = '<script>alert("secret")</script><img src=x onerror=alert(1)>';
  const $ = load(
    renderConnectionPage({
      ...base,
      phase: "consent",
      csrf: attack,
      message: "raw-provider-token-secret",
      oauth: { clientName: attack, clientOrigin: attack, redirectUri: attack },
    }),
  );
  expect($("script, img, [onerror]")).toHaveLength(0);
  expect($("dd").first().text()).toBe(attack);
  expect($("body").text()).not.toContain("raw-provider-token-secret");
  expect($("[role=alert]").text()).toBe(CONNECTION_MESSAGES.unavailable);
  const error = load(
    renderConnectionPage({ ...base, phase: "error", message: CONNECTION_MESSAGES.expired }),
  );
  expect(error("[role=alert]").text()).toBe(CONNECTION_MESSAGES.expired);
});

test("styles include mobile controls, dark tokens, visible focus, and no imported assets", () => {
  expect(CONNECTION_STYLES).toContain("--control: 52px");
  expect(CONNECTION_STYLES).toContain(":focus-visible");
  expect(CONNECTION_STYLES).toContain("prefers-color-scheme: dark");
  expect(CONNECTION_STYLES).toContain("overflow-wrap: anywhere");
  expect(CONNECTION_STYLES).not.toMatch(/@import|url\(|animation:|position:\s*fixed/);
});
