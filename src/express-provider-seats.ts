import { load } from "cheerio";
import { z } from "zod";
import {
  type ExpressTrip,
  ProviderError,
  parseProviderValue,
  type SeatMap,
  SeatMapSchema,
} from "./provider-types";

export function parseExpressSeats(html: string, trip?: ExpressTrip): SeatMap {
  const $ = load(html);
  if (trip) {
    const expected = {
      deprCd: trip.departureId,
      arvlCd: trip.arrivalId,
      deprDtm: trip.departureDate,
      deprTime: trip.departureTime,
      alcnDeprTime: trip.scheduledDepartureTime,
      alcnDeprTrmlNo: trip.expressIdentity.allocationDepartureId,
      alcnArvlTrmlNo: trip.expressIdentity.allocationArrivalId,
      indVBusClsCd: trip.busClassId,
      cacmCd: trip.carrierId,
    };
    for (const [name, value] of Object.entries(expected)) {
      if (
        $(`input[name=${name}]`).length !== 1 ||
        $(`input[name=${name}]`).attr("value") !== value
      ) {
        throw new ProviderError("layout", "Express seat response differs from the selected trip");
      }
    }
  }
  const boxes = $(".bg_seatBox");
  const inputs = boxes.find("input[name=seatBoxDtl]");
  if (boxes.length !== 1 || inputs.length === 0) {
    throw new ProviderError("layout", "Express provider did not return a seat map");
  }
  const numbers = parseProviderValue(
    z.array(z.coerce.number().int().positive()).min(1),
    inputs.toArray().map((node) => $(node).attr("value")),
  );
  if (new Set(numbers).size !== numbers.length) {
    throw new ProviderError("layout", "Express provider returned duplicate seats");
  }
  const regular =
    !/wheel/i.test(boxes.attr("class") ?? "") &&
    boxes.find(".seatList").length === 1 &&
    boxes.find(".seatList").children().length === numbers.length &&
    numbers.every((number, index) => number === index + 1);
  const candidateColumns =
    regular && boxes.hasClass("seat28") && numbers.length === 28
      ? 3
      : regular && boxes.hasClass("seat45") && numbers.length === 45
        ? 4
        : null;
  const rearStart = candidateColumns === 3 ? 25 : 41;
  const columns =
    candidateColumns !== null &&
    inputs
      .toArray()
      .every(
        (node, index) =>
          $(node).parent().hasClass("last_seat") ===
          index + 1 >= (candidateColumns === 4 ? 42 : rearStart),
      )
      ? candidateColumns
      : null;
  const adjacentGroups: number[][] = [];
  if (columns !== null) {
    for (let number = 1; number < rearStart; number += columns) {
      adjacentGroups.push([number, number + 1]);
      if (columns === 4) adjacentGroups.push([number + 2, number + 3]);
    }
    adjacentGroups.push(numbers.filter((number) => number >= rearStart));
  }
  const quote = (name: string) => {
    const input = $(`input[name=${name}]`);
    if (input.length !== 1) throw new ProviderError("layout", "Missing express fare field");
    const raw = input.attr("value");
    if (raw === "") return null;
    return {
      unitFareKrw: parseProviderValue(z.string().regex(/^\d+$/).transform(Number), raw),
      fareKindCode: null,
    };
  };
  const fareQuotes = {
    adults: quote("adltFee"),
    students: quote("teenFee"),
    children: quote("chldFee"),
  };
  return parseProviderValue(SeatMapSchema, {
    seats: inputs.toArray().map((node, index) => {
      const number = numbers[index];
      if (number === undefined) throw new ProviderError("layout", "Missing express seat number");
      const rear = columns !== null && number >= rearStart;
      return {
        number,
        available: $(node).attr("disabled") === undefined,
        row:
          columns === null
            ? null
            : rear
              ? Math.ceil(rearStart / columns)
              : Math.ceil(number / columns),
        column:
          columns === null ? null : rear ? number - rearStart + 1 : ((number - 1) % columns) + 1,
        side:
          columns === null
            ? "unknown"
            : rear
              ? "rear"
              : (number - 1) % columns < 2
                ? "left"
                : "right",
      };
    }),
    adultFareKrw: fareQuotes.adults?.unitFareKrw ?? null,
    fareQuotes,
    layoutStatus: columns === null ? "unknown" : "verified",
    adjacentGroups,
  });
}
