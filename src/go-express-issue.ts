import { validateGoHoldFare } from "./go-bus-fares";
import { GoBusError, type GoBusHold } from "./go-bus-types";
import { GoExpressHoldSchema } from "./go-express-types";
import { GoPurchaseError } from "./go-purchase-types";

export function buildGoExpressIssueBody(hold: GoBusHold) {
  const checked = GoExpressHoldSchema.safeParse(hold);
  if (!checked.success) throw new GoPurchaseError("unsupported");
  const {
    seats,
    trip: { row },
  } = checked.data;
  let total: number;
  try {
    total = validateGoHoldFare(checked.data);
  } catch (error) {
    if (error instanceof GoBusError) throw new GoPurchaseError("unsupported");
    throw error;
  }
  return {
    tot_amt: String(total),
    adm_knd_cod: "N",
    tck_div: "01",
    car_cod: "NA",
    usr_chk: "1",
    usr_id: "0123456789",
    lin_tim: row.lintim,
    lin_end1: row.linend1,
    tim_dte: row.timdte,
    ter_fr: row.terfro,
    ter_to: row.tertoo,
    tim_tim_i: row.timtimo,
    tim_tim: row.timtim,
    ter_sfr: row.terfri,
    ter_sto: row.tertoi,
    bus_gra: row.busgrao,
    cor_cod: row.corcodo,
    tissu_mns_cd: "GA11",
    cnt_100: String(seats.filter((seat) => seat.passengerType === "adult").length),
    cnt_050: String(seats.filter((seat) => seat.passengerType === "child").length),
    amt_100: String(seats.filter((seat) => seat.passengerType === "student").length),
    amt_050: "0",
    sncn_hcnt: "0",
    dspr_hcnt: "0",
    dc_dvs_cd: "0",
    prmm_dc_dvs_cd1: "0",
    adlt_dc_hcnt1: "0",
    vtrn_no: "",
    vtrn_auth_id: "",
    pcpy_no: seats.map((seat) => seat.holdId).join(":"),
    set_no_web: seats.map((seat) => seat.seat).join(":"),
    tck_pay: row.tckpay,
    agrm_yn: "",
  } satisfies Readonly<Record<string, string>>;
}
