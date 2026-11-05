import { GoBusError, type GoBusSeatInfo } from "./go-bus-types";

export function selectableGoSeats(info: GoBusSeatInfo): readonly number[] {
  const states = new Map<number, string>();
  for (const entry of info.seatlist) {
    for (const [number, state] of Object.entries(entry)) {
      const seat = Number(number);
      if (seat < 1 || seat > Number(info.totcnt) || states.has(seat))
        throw new GoBusError("response");
      states.set(seat, state);
    }
  }
  return [...states]
    .filter(([, state]) => state === "Y")
    .map(([seat]) => seat)
    .sort((a, b) => a - b);
}
