import { describe, expect, test } from "bun:test";
import { load } from "cheerio";
import { createCheckoutHandler } from "../src/checkout";
import { parseTrips } from "../src/provider-html";
import { TripReferences } from "../src/trip-references";

const [trip] = parseTrips(
  await Bun.file(new URL("./fixtures/dispatch.html", import.meta.url)).text(),
);
if (trip?.service !== "intercity")
  throw new TypeError("Dispatch fixture must contain an intercity trip");

describe("official seat selection handoff", () => {
  test("serializes official trip fields into a POST form", async () => {
    const references = new TripReferences(() => 0);
    const reference = references.add(trip);
    const handler = createCheckoutHandler({ references });
    const response = handler(new Request(`https://mcp.example/checkout/${reference}`));
    expect(response?.status).toBe(200);
    const $ = load((await response?.text()) ?? "");
    expect($("form").attr("method")).toBe("post");
    expect($("form").attr("action")).toBe("https://txbus.t-money.co.kr/otck/readSatsFee.do");
    const fields = new Map(
      $("input")
        .toArray()
        .map((input) => [$(input).attr("name"), $(input).attr("value")]),
    );
    expect(fields.get("rot_Id")).toBe(trip.routeId);
    expect(fields.get("depr_Trml_Cd")).toBe(trip.departureId);
    expect(fields.get("arvl_Trml_Cd")).toBe(trip.arrivalId);
    expect(fields.get("alcn_Dt")).toBe(trip.serviceDate);
    expect(fields.get("depr_Time")).toBe(trip.scheduledDepartureTime);
    expect(fields.get("atl_Depr_Dt_S1")).toBe(trip.departureDate);
    expect(fields.get("atl_Depr_Time_S1")).toBe(trip.departureTime);
    expect(fields.get("ig")).toBe("1");
    expect(fields.get("im")).toBe("0");
    expect(fields.get("ic")).toBe("0");
    expect($("button[type=submit]").length).toBe(1);
  });

  test("preserves hostile provider names as field data without injecting markup", async () => {
    const malicious = `"><img src=x onerror=alert(1)><script>alert('x')</script>&`;
    const references = new TripReferences(() => 0);
    const reference = references.add({ ...trip, carrierName: malicious, departureName: malicious });
    const handler = createCheckoutHandler({ references });
    const response = handler(new Request(`https://mcp.example/checkout/${reference}`));
    const $ = load((await response?.text()) ?? "");
    expect($("input[name=bus_Cacm_Nm]").attr("value")).toBe(malicious);
    expect($("input[name=depr_Trml_Nm]").attr("value")).toBe(malicious);
    expect($("img, [onerror]").length).toBe(0);
    expect($("script").length).toBe(1);
  });

  test("serves a nonce-restricted script with no caching or referrer disclosure", async () => {
    const references = new TripReferences(() => 0);
    const reference = references.add(trip);
    const response = createCheckoutHandler({ references })(
      new Request(`https://mcp.example/checkout/${reference}`),
    );
    const $ = load((await response?.text()) ?? "");
    const nonce = $("script").attr("nonce");
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
    expect(response?.headers.get("Content-Security-Policy")).toBe(
      `default-src 'none'; form-action https://txbus.t-money.co.kr; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
    );
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response?.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  test("allows the same fresh reference to be opened again", () => {
    const references = new TripReferences(() => 0);
    const reference = references.add(trip);
    const handler = createCheckoutHandler({ references });
    handler(new Request(`https://mcp.example/checkout/${reference}`));
    const response = handler(new Request(`https://mcp.example/checkout/${reference}`));
    expect(response?.status).toBe(200);
  });

  test("returns 410 for an expired reference", () => {
    let now = 0;
    const references = new TripReferences(() => now);
    const reference = references.add(trip);
    const handler = createCheckoutHandler({ references });
    now = 15 * 60_000;
    const response = handler(new Request(`https://mcp.example/checkout/${reference}`));
    expect(response?.status).toBe(410);
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
  });

  test.each(["/checkout", "/checkout/", "/checkout/invalid", `/checkout/${crypto.randomUUID()}`])(
    "returns 410 for a missing or unknown reference: %s",
    (path) => {
      const handler = createCheckoutHandler({ references: new TripReferences(() => 0) });
      const response = handler(new Request(`https://mcp.example${path}`));
      expect(response?.status).toBe(410);
    },
  );

  test.each(["POST", "HEAD", "DELETE"])("rejects %s without generating a handoff", (method) => {
    const references = new TripReferences(() => 0);
    const reference = references.add(trip);
    const handler = createCheckoutHandler({ references });
    const response = handler(new Request(`https://mcp.example/checkout/${reference}`, { method }));
    expect(response?.status).toBe(405);
    expect(response?.headers.get("Allow")).toBe("GET");
  });

  test("leaves unrelated routes to the caller", () => {
    const handler = createCheckoutHandler({ references: new TripReferences(() => 0) });
    expect(handler(new Request("https://mcp.example/mcp"))).toBeUndefined();
  });
});

test("official handoff preserves mixed passenger counts", async () => {
  // Given: a reference selected for two adults, one student and three children.
  const references = new TripReferences(() => 0);
  const reference = references.add({
    ...trip,
    adultCount: 2,
    studentCount: 1,
    childCount: 3,
    passengers: { adults: 2, students: 1, children: 3 },
  });
  // When: open the official checkout handoff.
  const response = createCheckoutHandler({ references })(
    new Request(`https://mcp.example/checkout/${reference}`),
  );
  const $ = load((await response?.text()) ?? "");
  // Then: the provider receives the exact composition.
  expect([$("input[name=ig]").val(), $("input[name=im]").val(), $("input[name=ic]").val()]).toEqual(
    ["2", "1", "3"],
  );
});
