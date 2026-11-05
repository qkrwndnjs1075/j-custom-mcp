import { describe, expect, test } from "bun:test";
import { createExpressSeatForm, KobusExpressClient } from "../src/express-provider";
import { ExpressRoutesSchema, parseExpressSchedule } from "../src/express-provider-html";
import { parseExpressSeats } from "../src/express-provider-seats";
import { ProviderError, parseProviderValue } from "../src/provider-types";

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
async function schedule(name = "schedule.html", date = "2026-10-26") {
  const routes = parseProviderValue(
    ExpressRoutesSchema,
    JSON.parse(await fixture("routes.json")),
  ).rotInfList;
  const route = routes.find((route) => route.deprCd === "021" && route.arvlCd === "393");
  if (!route) throw new ProviderError("layout", "Fixture route missing");
  return parseExpressSchedule(await fixture(name), { search: { ...search, date }, route });
}

describe("express public responses", () => {
  test("filters time while retaining exact provider identity and unknown quotes", async () => {
    // Given a captured official schedule and explicit afternoon search.
    const page = await schedule();
    // When the selected departure is inspected.
    const trip = page.trips.find((trip) => trip.departureTime === "142000");
    // Then the native identity is retained without a fabricated capacity or fare.
    expect(trip).toMatchObject({
      service: "express",
      carrierId: "53",
      busClassId: "1",
      remainingSeats: 19,
      totalSeats: null,
      adultFareKrw: null,
      totalFareKrw: null,
    });
    expect(trip && "routeId" in trip).toBe(false);
    expect(page.trips.every((trip) => trip.departureTime >= "140000")).toBe(true);
    expect(page).toMatchObject({ continuation: null, coverage: "end" });
  });
  test("retains sold-out afternoon departures without inventing allocations", async () => {
    // Given/When an official sold-out-date schedule is parsed.
    const page = await schedule("sold-out.html", "2026-10-25");
    // Then unavailable rows remain visible with no actionable identity.
    expect(page.trips).toHaveLength(0);
    expect(page.unavailable.length).toBeGreaterThan(0);
    expect(
      page.unavailable.every((row) => row.availability === "sold_out" && row.tripKey === null),
    ).toBe(true);
  });
  test("recognizes only the explicit no-allocation response", async () => {
    // Given/When the official empty-date response is parsed.
    const page = await schedule("empty.html", "2026-12-23");
    // Then it has terminal coverage and no fabricated trips.
    expect(page).toMatchObject({
      trips: [],
      unavailable: [],
      coverage: "end",
      emptyStatus: "unknown_empty",
    });
  });
  test("rejects markup changes instead of returning empty results", async () => {
    // Given a changed provider selection action.
    const routes = ExpressRoutesSchema.parse(JSON.parse(await fixture("routes.json"))).rotInfList;
    const route = routes.find((route) => route.deprCd === "021" && route.arvlCd === "393");
    if (!route) throw new ProviderError("layout", "Fixture route missing");
    const html = (await fixture("schedule.html")).replaceAll("fnSatsChc(", "changedAction(");
    // When/Then unknown actions fail closed.
    expect(() => parseExpressSchedule(html, { search, route })).toThrow(ProviderError);
  });
  test("preserves disabled seats and unquoted student fare with verified28-seat adjacency", async () => {
    // Given/When the public28-seat response is parsed.
    const map = parseExpressSeats(await fixture("seats.html"));
    // Then neither availability nor student price is guessed.
    expect(map).toMatchObject({
      totalSeats: 28,
      availableSeats: 19,
      adultFareKrw: 15100,
      layoutStatus: "verified",
      fareQuotes: { students: null, children: { unitFareKrw: 7600 } },
    });
    expect(map.seats.find((seat) => seat.number === 1)?.available).toBe(false);
    expect(map.adjacentGroups).toContainEqual([1, 2]);
    expect(map.adjacentGroups).toContainEqual([25, 26, 27, 28]);
    expect(map.adjacentGroups).not.toContainEqual([2, 3]);
  });
  test("uses45-seat aisles and a continuous rear row", async () => {
    // Given/When an ordinary45-seat response is parsed.
    const map = parseExpressSeats(await fixture("seats45.html"));
    // Then physical adjacency follows the captured provider CSS.
    expect(map.adjacentGroups).toContainEqual([3, 4]);
    expect(map.adjacentGroups).toContainEqual([41, 42, 43, 44, 45]);
    expect(map.adjacentGroups).not.toContainEqual([2, 3]);
  });
  test("does not assert adjacency for an unverified wheelchair layout", async () => {
    // Given an explicit special-layout class.
    const html = (await fixture("seats.html")).replace(
      "bg_seatBox seat28",
      "bg_seatBox seat28 seatWheel",
    );
    // When the response is parsed.
    const map = parseExpressSeats(html);
    // Then seats remain readable but adjacency is unknown.
    expect(map).toMatchObject({ layoutStatus: "unknown", adjacentGroups: [], totalSeats: 28 });
  });
  test("creates only the documented read-only seat-entry form", async () => {
    // Given a public express trip.
    const trip = (await schedule()).trips[0];
    if (trip?.service !== "express") throw new ProviderError("layout", "Fixture trip missing");
    // When constructing the official seat-page form.
    const form = createExpressSeatForm(trip);
    // Then allocation identity is retained and no seat selection or hold is submitted.
    expect(form.get("alcnDeprTime")).toBe(trip.scheduledDepartureTime);
    expect(form.get("alcnDeprTrmlNo")).toBe("021");
    expect(form.has("seatBoxDtl")).toBe(false);
    expect(form.has("pcpyNoAll")).toBe(false);
  });
  test("rejects another provider continuation before contacting upstream", async () => {
    // Given the public adapter and a foreign continuation.
    const client = new KobusExpressClient();
    // When/Then it refuses the continuation locally.
    await expect(
      client.searchTripPage({ ...search, continuation: "intercity-token" }),
    ).rejects.toThrow(ProviderError);
  });
});
