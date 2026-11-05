import { describe, expect, test } from "bun:test";
import { parseSeats, parseTerminals, parseTrips } from "../src/provider-html";
import { ProviderError } from "../src/provider-types";

const fixture = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

describe("official provider response parsing", () => {
  test("returns each departure once when desktop and mobile rows coexist", async () => {
    const html = await fixture("dispatch.html");
    const trips = parseTrips(html);
    expect(trips.map((trip) => [trip.departureTime, trip.adultFareKrw])).toEqual([
      ["113000", 17200],
      ["163000", 17200],
    ]);
  });

  test("returns an empty result when the provider explicitly reports no departures", async () => {
    const html = await fixture("dispatch-empty.html");
    const trips = parseTrips(html);
    expect(trips).toEqual([]);
  });

  test("throws when an HTML error replaces the schedule", () => {
    const html = "- 웹방화벽 관리자에 의해 차단 되었습니다.<br><br><br>";
    const parse = () => parseTrips(html);
    expect(parse).toThrow(ProviderError);
  });

  test("throws when an unknown availability state replaces a trip action", async () => {
    const html = (await fixture("dispatch.html")).replaceAll(
      "readSasFeeInf(",
      "changedProviderAction(",
    );
    const parse = () => parseTrips(html);
    expect(parse).toThrow(ProviderError);
  });

  test("preserves unavailable seats when the provider marks them disabled", async () => {
    const html = await fixture("seats.html");
    const map = parseSeats(html);
    expect(map).toEqual({
      seats: [
        { number: 1, available: false, row: null, column: null, side: "unknown" },
        { number: 2, available: false, row: null, column: null, side: "unknown" },
        { number: 3, available: true, row: null, column: null, side: "unknown" },
      ],
      adultFareKrw: 17200,
      fareQuotes: {
        adults: { unitFareKrw: 17200, fareKindCode: null },
        students: null,
        children: null,
      },
      totalSeats: 3,
      availableSeats: 1,
      layoutStatus: "unknown",
      adjacentGroups: [],
    });
  });

  test("throws when a seat page omits the fare", async () => {
    const html = (await fixture("seats.html")).replace('value="17200"', "");
    const parse = () => parseSeats(html);
    expect(parse).toThrow(ProviderError);
  });

  test("throws instead of reporting a free fare when the provider returns a blank value", async () => {
    const html = (await fixture("seats.html")).replace('value="17200"', 'value=""');
    const parse = () => parseSeats(html);
    expect(parse).toThrow(ProviderError);
  });

  test("throws when an HTML error replaces terminal JSON", () => {
    const response = "<html>Service unavailable</html>";
    const parse = () => parseTerminals(response);
    expect(parse).toThrow(ProviderError);
  });
});
