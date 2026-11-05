import { GoBusError } from "./go-bus-types";
import { serviceBody } from "./go-ticket-native";
import type { GoTicket, GoTicketIdentity } from "./go-ticket-types";

type PayloadInput = {
  readonly ticket: GoTicket;
  readonly selected: readonly GoTicketIdentity[];
  readonly orderNumber: string;
  readonly publicationDivision: string;
  readonly quotedAt: number;
};
export function cancellationFeeBody(input: PayloadInput): Readonly<Record<string, string>> {
  const first = input.selected[0];
  if (!first) throw new GoBusError("input");
  const date = new Date(input.quotedAt + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
  const join = (field: keyof GoTicketIdentity, delimiter = ":") =>
    input.selected.map((row) => row[field]).join(delimiter);
  const common = {
    REP_DTE: date,
    TER_FR: input.ticket.departureId,
    TER_TO: input.ticket.arrivalId,
    SET_NO: input.selected.map((row) => String(row.seat).padStart(2, "0")).join(":"),
    TOT_CNT: String(input.ticket.count),
    CAN_CNT: String(input.selected.length),
    CAD_FEE: "0",
    TCK_SEQ: join("ticketSequence"),
  };
  switch (input.ticket.service) {
    case "express":
      return serviceBody("express", {
        ...common,
        ACT_DTE: first.actDate,
        TCK_TER: first.ticketTerminal,
        TCK_WIN: join("ticketWindow"),
      });
    case "intercity":
      return {
        ...common,
        TISU_ID: join("issuanceId", "|"),
        TISU_PUB_DVS: input.publicationDivision,
        PUB_DTE: first.publicationDate,
        PUB_TER: first.publicationTerminal,
        PUB_WIN: first.publicationWindow,
        PUB_SNO: first.publicationNumber,
      };
  }
}
export function cancellationMutationBody(input: PayloadInput): Readonly<Record<string, string>> {
  const fee = cancellationFeeBody(input);
  switch (input.ticket.service) {
    case "express":
      return { ...fee, lin_sno: input.ticket.lineNumber, usr_chk: "", ord_sno: input.orderNumber };
    case "intercity": {
      const first = input.selected[0];
      if (!first) throw new GoBusError("input");
      const {
        PUB_DTE: _date,
        PUB_TER: _terminal,
        PUB_WIN: _window,
        PUB_SNO: _number,
        ...rest
      } = fee;
      return {
        ...rest,
        LIN_SNO: input.ticket.lineNumber,
        USR_CHK: "1",
        ORD_SNO: input.orderNumber,
        ACT_DTE: first.publicationDate,
        TCK_TER: first.publicationTerminal,
        TCK_WIN: first.publicationWindow,
        ADM_KND_COD: "N",
      };
    }
  }
}
