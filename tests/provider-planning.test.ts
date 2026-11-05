import { describe, expect, test } from "bun:test";
import { parseDispatch, parseSeats } from "../src/provider-html";
import { nextContinuation, readContinuation } from "../src/provider-pagination";
import { ProviderError } from "../src/provider-types";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
const search = {
  service: "intercity",
  departureId: "0671801",
  arrivalId: "2839701",
  date: "2026-10-23",
  time: "00:00",
  passengers: { adults: 1, students: 0, children: 0 },
} as const;

describe("provider planning contracts", () => {
  test("preserves the native inclusive cursor when a next page is offered", async () => {
    const html = await fixture("pagination-page1.html");
    const continuation = nextContinuation(html, search);
    if (!continuation) throw new Error("Fixture must offer a next page");
    const body = readContinuation({ ...search, continuation });
    expect(body?.get("depr_Time")).toBe("152000");
    expect(body?.get("bef_Aft_Dvs")).toBe("D");
  });

  test("preserves stable identity when consecutive native pages overlap", async () => {
    const [first, second] = await Promise.all([
      fixture("pagination-page1.html"),
      fixture("pagination-page2.html"),
    ]);
    const pages = [parseDispatch(first), parseDispatch(second)];
    expect(pages[0]?.trips.at(-1)?.tripKey).toBe(pages[1]?.trips[0]?.tripKey);
    expect(new Set(pages.flatMap((page) => page.trips.map((trip) => trip.tripKey))).size).toBe(19);
  });

  test("rejects a cursor when the caller changes the route", async () => {
    const continuation = nextContinuation(await fixture("pagination-page1.html"), search);
    if (!continuation) throw new Error("Fixture must offer a next page");
    const parse = () => readContinuation({ ...search, arrivalId: "3455101", continuation });
    expect(parse).toThrow(ProviderError);
  });

  test("ends pagination when the provider omits the next link", async () => {
    const html = await fixture("pagination-page3.html");
    const continuation = nextContinuation(html, search);
    expect(continuation).toBeNull();
  });

  test("keeps mobile-only services without inventing booking identifiers", async () => {
    const html = await fixture("dispatch-mobile-only.html");
    const page = parseDispatch(html);
    expect(page.trips).toEqual([]);
    expect(page.unavailable[0]).toMatchObject({
      tripKey: null,
      availability: "unavailable",
      departureTime: "094000",
      adultFareKrw: 36100,
      estimatedDurationMinutes: 215,
    });
    expect(page.emptyStatus).toBe("none");
  });

  test("preserves an unknown disabled status instead of assuming booking has not opened", async () => {
    const html = (await fixture("dispatch-mobile-only.html")).replaceAll(
      "모바일예매가능",
      "상태미확인",
    );
    const page = parseDispatch(html);
    expect(page.unavailable.every((trip) => trip.availability === "unknown")).toBe(true);
  });

  test("retains bookable departures when a real sold-out service shares the page", async () => {
    const page = parseDispatch(await fixture("dispatch-mixed-sold-out.html"));
    expect(page.trips.map((trip) => trip.departureTime)).toEqual(["150000", "170000", "185500"]);
    expect(page.unavailable).toEqual([
      {
        service: "intercity",
        tripKey: null,
        departureTime: "163500",
        carrierName: "충남고속",
        busClassName: "우등",
        adultFareKrw: 13700,
        estimatedDurationMinutes: 180,
        providerStatus: "매진",
        availability: "sold_out",
      },
    ]);
    expect(page.emptyStatus).toBe("none");
  });

  test("retains bookable departures beside terminal-only unassigned-seat services", async () => {
    const html = (await fixture("dispatch-mixed-sold-out.html")).replace(
      '<a class="btn_soldout">매진</a>',
      '<a class="btn_noseat">좌석 비지정 노선(터미널 직접구매)</a>',
    );
    const page = parseDispatch(html);
    expect(page.trips.map((trip) => trip.departureTime)).toEqual(["150000", "170000", "185500"]);
    expect(page.unavailable).toEqual([
      {
        service: "intercity",
        tripKey: null,
        departureTime: "163500",
        carrierName: "충남고속",
        busClassName: "우등",
        adultFareKrw: 13700,
        estimatedDurationMinutes: 180,
        providerStatus: "좌석 비지정 노선(터미널 직접구매)",
        availability: "unavailable",
      },
    ]);
    expect(page.emptyStatus).toBe("none");
  });

  test("rejects an unexpected action on an unassigned-seat service", async () => {
    const html = (await fixture("dispatch-mixed-sold-out.html")).replace(
      '<a class="btn_soldout">매진</a>',
      '<a class="btn_noseat" onclick="changedProviderAction()">좌석 비지정 노선(터미널 직접구매)</a>',
    );
    expect(() => parseDispatch(html)).toThrow(ProviderError);
  });

  test("does not infer a reason when the provider explicitly returns an empty list", async () => {
    const html = await fixture("dispatch-empty.html");
    const page = parseDispatch(html);
    expect(page.emptyStatus).toBe("unknown_empty");
  });

  test("keeps service identity when its available seat count reaches zero", async () => {
    const original = await fixture("dispatch.html");
    const originalTrip = parseDispatch(original).trips[0];
    const page = parseDispatch(original.replaceAll("'18','28'", "'0','28'"));
    expect(page.trips[0]?.tripKey).toBe(originalTrip?.tripKey);
    expect(page.trips[0]?.availability).toBe("sold_out");
  });

  test("separates aisle and row boundaries while preserving the continuous rear bench", async () => {
    const html = await fixture("seats-layout.html");
    const map = parseSeats(html);
    expect(map.layoutStatus).toBe("verified");
    expect(map.adjacentGroups).toContainEqual([1, 2]);
    expect(map.adjacentGroups).toContainEqual([3]);
    expect(map.adjacentGroups).toContainEqual([25, 26, 27, 28]);
    expect(map.seats.find((seat) => seat.number === 3)).toMatchObject({
      row: 1,
      column: 4,
      side: "right",
    });
  });

  test("withholds adjacency when an unverified seat layout appears", async () => {
    const html = (await fixture("seats-layout.html")).replace("string4 type3", "string4 type99");
    const map = parseSeats(html);
    expect(map.layoutStatus).toBe("unknown");
    expect(map.adjacentGroups).toEqual([]);
    expect(map.seats.every((seat) => seat.row === null && seat.column === null)).toBe(true);
  });

  test("rejects unknown seat state instead of making it available", async () => {
    const html = (await fixture("seats-layout.html")).replace(
      "seat_disabled.png",
      "seat_pending.png",
    );
    const parse = () => parseSeats(html);
    expect(parse).toThrow(ProviderError);
  });
});

test("mixed passenger cursor preserves counts and rejects composition changes", async () => {
  // Given: provider pagination for one adult, two students and one child.
  const passengers = { adults: 1, students: 2, children: 1 };
  const html = (await fixture("pagination-page1.html"))
    .replace(/(name="im"[^>]*value=")0/g, "$12")
    .replace(/(name="ic"[^>]*value=")0/g, "$11");
  const continuation = nextContinuation(html, { ...search, passengers });
  if (!continuation) throw new Error("Missing continuation");
  // When: resume the same passenger composition.
  const body = readContinuation({ ...search, passengers, continuation });
  // Then: all counts survive and a different composition is rejected.
  expect([body?.get("ig"), body?.get("im"), body?.get("ic")]).toEqual(["1", "2", "1"]);
  expect(() => readContinuation({ ...search, continuation })).toThrow(ProviderError);
});

test("seat fare parser preserves provider fare codes without inferring discounts", async () => {
  // Given: provider returns explicit prices and category codes.
  const html = (await fixture("seats.html")).replace(
    "</form>",
    '<input id="imFee" value="7100"><input id="icFee" value="3300"><input id="ig_Knd_Cd" value="IG00"><input id="im_Knd_Cd" value="IM20"><input id="ic_Knd_Cd" value="IC50"></form>',
  );
  // When: parse the seat response.
  const result = parseSeats(html);
  // Then: prices and codes match the response exactly.
  expect(result.fareQuotes).toEqual({
    adults: { unitFareKrw: 17200, fareKindCode: "IG00" },
    students: { unitFareKrw: 7100, fareKindCode: "IM20" },
    children: { unitFareKrw: 3300, fareKindCode: "IC50" },
  });
});
