import { z } from "zod";
import type { GoBusHttp } from "./go-bus-http";
import { type GoBusContext, goBusAliases, parseGoBusValue } from "./go-bus-types";
import { GoPurchaseError } from "./go-purchase-types";

const identifier = z.string().min(1).max(1024);
export const ReceiptBaselineSchema = z
  .array(identifier)
  .refine((ids) => new Set(ids).size === ids.length)
  .readonly();

export async function captureGoExpressReceiptBaseline(
  http: GoBusHttp,
  context: GoBusContext,
  memberSerialNumber: string,
): Promise<readonly string[]> {
  if (!identifier.safeParse(memberSerialNumber).success) throw new GoPurchaseError("configuration");
  const raw = await http.post(context, {
    service: "express",
    path: "ticket/selectBuyTckListSecu.do",
    body: { mem_sno: memberSerialNumber, hp_syn_yn: "N", arpr_trml_yn: "N" },
  });
  const list = parseGoBusValue(
    z.object({ ticketList: z.array(z.unknown()) }),
    goBusAliases(raw, { ticketList: ["ticket_list", "TICKET_LIST"] }),
  );
  const ids = list.ticketList.map(
    (ticket) =>
      parseGoBusValue(
        z.object({ linSno: identifier }),
        goBusAliases(ticket, { linSno: ["lin_sno", "LIN_SNO"] }),
      ).linSno,
  );
  return parseGoBusValue(ReceiptBaselineSchema, ids);
}
