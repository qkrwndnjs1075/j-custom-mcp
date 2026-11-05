import { load } from "cheerio";
import { ProviderError, parseProviderValue, type SeatMap, SeatMapSchema } from "./provider-types";

export function parseSeats(html: string): SeatMap {
  const $ = load(html);
  if ($("form#readPcpySats[action='/otck/readPcpySats.do']").length !== 1) {
    throw new ProviderError("layout", "Provider did not return a seat selection page");
  }
  const layout = $(".seat");
  const elements = layout.find("li:has(img[alt$='번좌석'])").toArray();
  const knownColumns = layout.hasClass("string4") && layout.hasClass("type3");
  const rows = layout.children("ul").toArray();
  const groups: number[][] = [];
  const positions = new Map<
    object,
    { row: number; column: number; side: "left" | "right" | "rear" | "unknown" }
  >();
  let verified = layout.length === 1 && knownColumns && rows.length === 9 && elements.length === 28;
  const seenRows = new Set<number>();
  for (const rowElement of rows) {
    const row = Number(
      $(rowElement)
        .attr("class")
        ?.match(/(?:^|\s)line(\d+)(?:\s|$)/)?.[1],
    );
    const rowSeats = $(rowElement).children("li").toArray();
    if (
      !Number.isInteger(row) ||
      row < 1 ||
      row > 9 ||
      seenRows.has(row) ||
      rowSeats.length === 0
    ) {
      verified = false;
      continue;
    }
    seenRows.add(row);
    const gaps = rowSeats.map((seat) => ($(seat).hasClass("case") ? 1 : 0));
    const rear = gaps.every((gap) => gap === 0) && rowSeats.length === 4;
    if (rear && row !== 9) verified = false;
    if (!rear && (rowSeats.length !== 3 || gaps.join(",") !== "0,0,1")) verified = false;
    let column = 0;
    let group: number[] = [];
    rowSeats.forEach((seat, index) => {
      const gap = gaps[index] ?? 0;
      if (gap > 0 && group.length > 0) {
        groups.push(group);
        group = [];
      }
      column += 1 + gap;
      const number = Number($(seat).find("span").text().trim());
      group.push(number);
      positions.set(seat, {
        row,
        column,
        side: rear ? "rear" : column <= 2 ? "left" : column >= 4 ? "right" : "unknown",
      });
    });
    groups.push(group);
  }
  const seats = elements.map((element) => {
    const source = $(element).find("img").attr("src");
    const disabled = $(element).hasClass("disabled");
    if (source !== (disabled ? "/images/bg/seat_disabled.png" : "/images/bg/seat_off.png")) {
      throw new ProviderError("layout", "Unrecognized provider seat availability state");
    }
    const number = $(element).find("span").text().trim();
    const position = positions.get(element);
    if (!position) verified = false;
    return { number, available: !disabled, position };
  });
  if (new Set(seats.map((seat) => seat.number)).size !== seats.length) {
    throw new ProviderError("layout", "Provider returned duplicate seat numbers");
  }
  return parseProviderValue(SeatMapSchema, {
    seats: seats.map(({ number, available, position }) => ({
      number,
      available,
      row: verified ? position?.row : null,
      column: verified ? position?.column : null,
      side: verified ? position?.side : "unknown",
    })),
    adultFareKrw: $("#igFee").attr("value"),
    fareQuotes: Object.fromEntries(
      (
        [
          ["adults", "ig"],
          ["students", "im"],
          ["children", "ic"],
        ] as const
      ).map(([kind, prefix]) => {
        const fee = $(`#${prefix}Fee`).attr("value");
        const code = $(`#${prefix}_Knd_Cd`).attr("value");
        if (fee === undefined || fee === "") return [kind, null];
        if (!/^\d+$/.test(fee)) throw new ProviderError("layout", "Invalid passenger fare");
        return [kind, { unitFareKrw: Number(fee), fareKindCode: code || null }];
      }),
    ),
    layoutStatus: verified ? "verified" : "unknown",
    adjacentGroups: verified ? groups : [],
  });
}
