import { z } from "zod";
import type { GoBusHttp } from "./go-bus-http";
import { type GoBusContext, GoBusError, parseGoBusValue } from "./go-bus-types";

export const GoBusTerminalSchema = z
  .object({
    TER_COD: z.string().min(1).max(32),
    TER_COD2: z.string().max(32).nullish(),
    TER_NAM: z.string().max(256).nullish(),
    TER_NAM2: z.string().max(256).nullish(),
    ARPR_TRML_YN: z.string().max(8).nullish(),
    ARPR_FR_YN: z.string().max(8).nullish(),
    ARPR_TO_YN: z.string().max(8).nullish(),
    SYS_DVS_COD: z.string().max(32).nullish(),
    MBL_MRS_PSB_DNO: z.string().max(32).nullish(),
  })
  .readonly();
export type GoBusTerminal = z.infer<typeof GoBusTerminalSchema>;

export async function readGoBusTerminals(http: GoBusHttp, context: GoBusContext) {
  const response = await http.post(context, {
    path: "common/selectloadingInfo.do",
    body: { IN_DATE: "00000000000000" },
  });
  return parseGoBusValue(z.object({ TER_LIST: z.array(GoBusTerminalSchema).readonly() }), response)
    .TER_LIST;
}

export function resolveGoBusTerminal(
  terminals: readonly GoBusTerminal[],
  id: string,
): GoBusTerminal {
  const matches = terminals.filter(
    (terminal) => terminal.TER_COD === id || terminal.TER_COD2 === id,
  );
  const terminal = matches[0];
  if (matches.length !== 1 || !terminal) throw new GoBusError("trip_match");
  return terminal;
}

export function goBusTerminalCode(terminal: GoBusTerminal): string {
  return terminal.TER_COD2 && terminal.TER_COD2.length > terminal.TER_COD.length
    ? terminal.TER_COD2
    : terminal.TER_COD;
}
