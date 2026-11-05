import { expect, test } from "bun:test";
import { load } from "cheerio";
import { createCheckoutHandler } from "../src/checkout";
import { TripReferences } from "../src/trip-references";
import { ExpressFixtureProvider, expressMcp, expressTrip } from "./express-test-fixtures";

test("express checkout emits the verified KOBUS form and exact origin CSP", async () => {
  // Given an express allocation whose scheduled and pickup times differ.
  const references = new TripReferences(() => 0);
  const trip = expressTrip({ scheduledDepartureTime: "140000" });
  const reference = references.add(trip);
  // When the handoff is opened.
  const response = createCheckoutHandler({ references })(
    new Request(`https://mcp.test/checkout/${reference}`),
  );
  const $ = load((await response?.text()) ?? "");
  // Then the selected service and original allocation remain distinguishable.
  expect(response?.status).toBe(200);
  expect($("form").attr("action")).toBe("https://www.kobus.co.kr/mrs/satschc.do");
  expect($("form").attr("method")).toBe("post");
  expect(
    Object.fromEntries(
      $("input")
        .toArray()
        .map((input) => [$(input).attr("name"), $(input).val()]),
    ),
  ).toEqual({
    deprCd: "021",
    arvlCd: "393",
    deprNm: "센트럴시티(서울)",
    arvlNm: "서산",
    pathDvs: "sngl",
    pathStep: "1",
    deprDtm: "20261026",
    deprDtmOrg: "20261026",
    busClsCd: "0",
    rtrpChc: "1",
    deprTime: "142000",
    alcnDeprTime: "140000",
    alcnDeprTrmlNo: "021",
    alcnArvlTrmlNo: "393",
    indVBusClsCd: "1",
    cacmCd: "53",
    dcDvsCd: "0",
    prvtBbizEmpAcmtRt: "N",
    chldSftySatsYn: "N",
    dsprSatsYn: "N",
  });
  expect($("input[name=rot_Id],input[name=pcpyNoAll],input[name=seatBoxDtl]").length).toBe(0);
  expect($("script,meta[http-equiv=refresh]").length).toBe(0);
  expect($("button[type=submit]").text()).toBe("PC에서 코버스 좌석 선택");
  const nonce = $("style").attr("nonce");
  expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
  expect(response?.headers.get("Content-Security-Policy")).toBe(
    `default-src 'none'; form-action https://www.kobus.co.kr; style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
  );
});

test("express checkout escapes provider names without injecting markup", async () => {
  // Given hostile provider text.
  const references = new TripReferences(() => 0);
  const hostile = '"><img src=x onerror=alert(1)><script>alert(2)</script>&';
  const reference = references.add(
    expressTrip({
      departureName: hostile,
      arrivalName: hostile,
      carrierName: hostile,
      busClassName: hostile,
    }),
  );
  const handler = createCheckoutHandler({ references });
  // When the valid page is rendered.
  const response = handler(new Request(`https://mcp.test/checkout/${reference}`));
  const $ = load((await response?.text()) ?? "");
  // Then text remains field data.
  expect($("input[name=deprNm]").val()).toBe(hostile);
  expect($("main").text().split(hostile)).toHaveLength(5);
  expect($("img,[onerror]").length).toBe(0);
  expect($("script").length).toBe(0);
});

test.each(["Mozilla/5.0 (Linux; Android 15)", "Mozilla/5.0 (Macintosh; Intel Mac OS X)"])(
  "express checkout offers honest app navigation for %s",
  async (userAgent) => {
    // Given a selected trip with mixed passengers.
    const references = new TripReferences(() => 0);
    const reference = references.add(
      expressTrip({ adultCount: 2, studentCount: 1, childCount: 3 }),
    );
    // When a mobile or desktop browser opens the intermediary.
    const response = createCheckoutHandler({ references })(
      new Request(`https://mcp.test/checkout/${reference}`, {
        headers: { "User-Agent": userAgent },
      }),
    );
    const $ = load((await response?.text()) ?? "");
    // Then both devices remain on the same usable choice page, with only terminals in the app link.
    expect($("meta[name=viewport]").attr("content")).toBe("width=device-width, initial-scale=1");
    expect($("a").text()).toBe("티머니GO 앱에서 다시 선택");
    expect($("a").attr("href")).toBe("tmoneytia://bus/schedule?startID=021&endID=393");
    for (const text of [
      "센트럴시티(서울)",
      "서산",
      "2026-10-26",
      "14:20",
      "한양고속",
      "우등",
      "성인 2명",
      "학생 1명",
      "아동 3명",
      "좌석 미확보 · 결제 미완료",
      "PC에서만",
      "로그인",
      "버스 홈",
      "날짜·출발편·승객·좌석·결제를 다시 선택",
      "점유한 좌석을 이어받는 기능이 아닙니다",
    ])
      expect($("main").text()).toContain(text);
    expect($("script").length).toBe(0);
  },
);
test("expired express checkout references expose no provider form", async () => {
  // Given a reference that has reached its TTL.
  let now = 0;
  const references = new TripReferences(() => now, {
    tripReferences: 10,
    tripReferenceTtlSeconds: 1,
  });
  const reference = references.add(expressTrip());
  now = 1000;
  // When the expired handoff is opened.
  const expired = createCheckoutHandler({ references })(
    new Request(`https://mcp.test/checkout/${reference}`),
  );
  // Then no form or action can continue the handoff.
  expect(expired?.status).toBe(410);
  expect(load((await expired?.text()) ?? "")("form").length).toBe(0);
});

test("MCP prepares express checkout with refreshed fare and service identity", async () => {
  // Given a public express reference whose schedule fare is unknown.
  const references = new TripReferences(() => 0);
  const tripRef = references.add(expressTrip());
  const provider = new ExpressFixtureProvider();
  const mcp = await expressMcp({
    provider,
    references,
    checkoutBaseUrl: new URL("https://mcp.test"),
  });
  try {
    // When the caller explicitly selects official checkout within the fare cap.
    const result = await mcp.client.callTool({
      name: "prepare_checkout",
      arguments: { tripRef, maxFareKrw: 16000, payment: { method: "official_card" } },
    });
    // Then the MCP reports preparation, not booking, and retains express.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      service: "express",
      status: "requires_user_checkout",
      quotedFareKrw: 15100,
      checkoutUrl: `https://mcp.test/checkout/${tripRef}`,
      checkoutConstraints: {
        requiresDesktop: true,
        mobileAlternative: {
          kind: "app_navigation",
          url: "tmoneytia://bus/schedule?startID=021&endID=393",
          requiresAppLoginForTerminalPrefill: true,
          continuesHeldSeat: false,
          reselectionRequired: ["date", "departure", "passengers", "seats", "payment"],
        },
      },
    });
    expect(provider.seatTrips.map((trip) => trip.service)).toEqual(["express"]);
  } finally {
    await mcp.close();
  }
});

test("web-ineligible express checkout fails before seat lookup and blocks direct handoff", async () => {
  // Given the official website eligibility flag is false.
  const references = new TripReferences(() => 0);
  const base = expressTrip();
  const tripRef = references.add(
    expressTrip({ expressIdentity: { ...base.expressIdentity, webCheckoutEligible: false } }),
  );
  const provider = new ExpressFixtureProvider();
  const mcp = await expressMcp({
    provider,
    references,
    checkoutBaseUrl: new URL("https://mcp.test"),
  });
  try {
    // When preparing the unsupported website route.
    const result = await mcp.client.callTool({
      name: "prepare_checkout",
      arguments: { tripRef, maxFareKrw: 16000, payment: { method: "official_card" } },
    });
    // Then no upstream seat call occurs and the handoff route is unavailable.
    expect(result.isError).toBe(true);
    expect(provider.seatTrips).toHaveLength(0);
    expect(
      createCheckoutHandler({ references })(new Request(`https://mcp.test/checkout/${tripRef}`))
        ?.status,
    ).toBe(409);
  } finally {
    await mcp.close();
  }
});

test.each([true, false])(
  "payment discovery uses express account context and web eligibility=%s",
  async (webCheckoutEligible) => {
    // Given a trip with explicit website eligibility and an account service recorder.
    const references = new TripReferences(() => 0);
    const base = expressTrip();
    const tripRef = references.add(
      expressTrip({ expressIdentity: { ...base.expressIdentity, webCheckoutEligible } }),
    );
    const services: string[] = [];
    const account = {
      getStatus: async (service: string) => {
        services.push(service);
        return { connection: "not_connected" as const };
      },
    };
    const mcp = await expressMcp({
      provider: new ExpressFixtureProvider(),
      references,
      account,
      checkoutBaseUrl: new URL("https://mcp.test"),
    });
    try {
      // When payment paths are requested through MCP.
      const result = await mcp.client.callTool({
        name: "get_payment_options",
        arguments: { tripRef },
      });
      // Then only the trip's service is queried and website status matches the provider flag.
      expect(services).toEqual(["express"]);
      expect(result.structuredContent).toMatchObject({
        service: "express",
        options: [
          {
            payment: { method: "official_card" },
            status: webCheckoutEligible ? "requires_desktop" : "unavailable",
            checkoutConstraints: {
              requiresDesktop: true,
              mobileAlternative: {
                kind: "app_navigation",
                url: "tmoneytia://bus/schedule?startID=021&endID=393",
                continuesHeldSeat: false,
              },
            },
          },
        ],
      });
    } finally {
      await mcp.close();
    }
  },
);

test("capabilities disclose the same express desktop and app navigation limits", async () => {
  // Given checkout is configured.
  const mcp = await expressMcp({
    provider: new ExpressFixtureProvider(),
    references: new TripReferences(() => 0),
    checkoutBaseUrl: new URL("https://mcp.test"),
  });
  try {
    // When the client discovers checkout capabilities.
    const result = await mcp.client.callTool({ name: "get_service_capabilities", arguments: {} });
    // Then it cannot interpret express as universal mobile checkout or held-seat continuation.
    expect(result.structuredContent).toMatchObject({
      officialCheckout: {
        serviceConstraints: {
          express: {
            requiresDesktop: true,
            mobileAlternative: {
              kind: "app_navigation",
              prefilledFields: ["departureId", "arrivalId"],
              requiresAppLoginForTerminalPrefill: true,
              continuesHeldSeat: false,
              reselectionRequired: ["date", "departure", "passengers", "seats", "payment"],
            },
          },
        },
      },
    });
  } finally {
    await mcp.close();
  }
});
