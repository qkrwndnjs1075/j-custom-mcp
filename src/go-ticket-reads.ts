import type { GoBusHttp } from "./go-bus-http";
import { GoBusError } from "./go-bus-types";
import { type NativeTicket, nativeRows, nativeTicket, serviceBody } from "./go-ticket-native";
import type { GoTicket, GoTicketAccount } from "./go-ticket-types";

export class GoTicketReads {
  constructor(readonly http: GoBusHttp) {}
  async history(
    account: GoTicketAccount,
    service: GoTicket["service"],
  ): Promise<readonly NativeTicket[]> {
    const raw = await this.http.post(account.context, {
      service,
      path:
        service === "express" ? "user/selectMyPagePayListSecu.do" : "user/selectMyPagePayList.do",
      body: serviceBody(service, {
        BMG_COD: "0",
        ...(service === "express" ? { MEM_SNO: account.memberSerialNumber } : {}),
      }),
    });
    return nativeRows(raw, "payList").map(nativeTicket);
  }
  async detail(account: GoTicketAccount, ticket: GoTicket) {
    return nativeTicket(
      await this.http.post(account.context, {
        service: ticket.service,
        path: "ticket/selectBuyTckInfo2.do",
        body: serviceBody(ticket.service, {
          MEM_SNO: account.memberSerialNumber,
          LIN_SNO: ticket.lineNumber,
        }),
      }),
    );
  }
  async tickets(account: GoTicketAccount, ticket: GoTicket): Promise<readonly unknown[]> {
    return nativeRows(
      await this.http.post(account.context, {
        service: ticket.service,
        path: "ticket/selectBuyTckInfoList2.do",
        body: serviceBody(ticket.service, {
          MEM_SNO: account.memberSerialNumber,
          LIN_SNO: ticket.lineNumber,
        }),
      }),
      "tckList",
    );
  }
  async candidates(account: GoTicketAccount, ticket: GoTicket): Promise<readonly unknown[]> {
    return nativeRows(
      await this.http.post(account.context, {
        service: ticket.service,
        path: "ticket/selectCanTckList.do",
        body: serviceBody(ticket.service, { LIN_SNO: ticket.lineNumber }),
      }),
      "ticketList",
    );
  }
  async receipt(
    account: GoTicketAccount,
    row: NativeTicket,
    service: GoTicket["service"],
  ): Promise<NativeTicket> {
    if (!row.SORT_DTE) throw new GoBusError("response");
    return nativeTicket(
      await this.http.post(account.context, {
        service,
        path: "user/selectMyPagePayInfo2.do",
        body: serviceBody(service, {
          BMG_COD: "4",
          LIN_SNO: row.LIN_SNO,
          SORT_DTE: row.SORT_DTE,
          ...(service === "express" ? { IS_TIM: "Y" } : {}),
        }),
      }),
    );
  }
}
