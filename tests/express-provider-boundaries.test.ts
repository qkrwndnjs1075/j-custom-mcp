import { expect, test } from "bun:test";
import { KobusExpressClient } from "../src/express-provider";
import { ExpressRoutesSchema, parseExpressSchedule } from "../src/express-provider-html";
import { parseExpressSeats } from "../src/express-provider-seats";
import { ProviderError } from "../src/provider-types";

const fixture = (name: string) =>
  Bun.file(new URL(`./fixtures/express/${name}`, import.meta.url)).text();
const search = {
  service: "express",
  departureId: "021",
  arrivalId: "393",
  date: "2026-10-26",
  time: "14:00",
  passengers: { adults: 1, students: 0, children: 0 },
} as const;
async function parse(html: string) {
  const routes = ExpressRoutesSchema.parse(JSON.parse(await fixture("routes.json"))).rotInfList;
  const route = routes.find((route) => route.deprCd === "021" && route.arvlCd === "393");
  if (!route) throw new ProviderError("layout", "Fixture route missing");
  return parseExpressSchedule(html, { search, route });
}
test("preserves website ineligibility without inferring native unavailability", async () => {
  // Given the official website-eligibility flag set to N.
  const html = (await fixture("schedule.html")).replaceAll("'0','Y','N'", "'0','N','N'");
  // When the schedule is parsed.
  const page = await parse(html);
  // Then available allocations survive with the explicit website restriction.
  expect(page.trips.length).toBeGreaterThan(0);
  expect(
    page.trips.every(
      (trip) => trip.service === "express" && !trip.expressIdentity.webCheckoutEligible,
    ),
  ).toBe(true);
});
test("rejects a seat response for another allocation", async () => {
  // Given a valid trip and a response with a changed carrier.
  const trip = (await parse(await fixture("schedule.html"))).trips.find(
    (trip) => trip.departureTime === "142000",
  );
  if (trip?.service !== "express") throw new ProviderError("layout", "Fixture trip missing");
  const html = (await fixture("seats.html")).replace(
    'name="cacmCd" id="cacmCd" value="53"',
    'name="cacmCd" id="cacmCd" value="52"',
  );
  // When/Then identity mismatch fails closed.
  expect(() => parseExpressSeats(html, trip)).toThrow(ProviderError);
});
test("preserves all blank fares as unquoted instead of free", async () => {
  // Given blank adult and child quotes, in addition to the captured blank student quote.
  const html = (await fixture("seats.html"))
    .replace('value="15100"', 'value=""')
    .replace('value="7600"', 'value=""');
  // When the seat page is parsed.
  const map = parseExpressSeats(html);
  // Then prices remain unknown.
  expect(map).toMatchObject({
    adultFareKrw: null,
    fareQuotes: { adults: null, students: null, children: null },
  });
});
test("performs only the read-only seat endpoint for the selected allocation", async () => {
  // Given a selected public trip and a captured response.
  const trip = (await parse(await fixture("schedule.html"))).trips.find(
    (trip) => trip.departureTime === "142000",
  );
  if (!trip) throw new ProviderError("layout", "Fixture trip missing");
  const paths: string[] = [];
  const client = new KobusExpressClient(async (input) => {
    paths.push(new URL(input instanceof Request ? input.url : String(input)).pathname);
    return new Response(await fixture("seats.html"));
  });
  // When the map is requested.
  const map = await client.getSeats(trip);
  // Then the map is returned without contacting a hold or reservation endpoint.
  expect(map.totalSeats).toBe(28);
  expect(paths).toEqual(["/mrs/satschc.do"]);
});
