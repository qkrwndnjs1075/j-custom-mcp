import { createExpressSeatForm } from "./express-provider";
import { createSeatForm, type Trip } from "./provider-types";

export const EXPRESS_CHECKOUT_CONSTRAINTS = {
  requiresDesktop: true,
  notice: "코버스 웹 좌석 선택은 PC에서만 이용할 수 있습니다.",
  mobileAlternative: {
    kind: "app_navigation",
    label: "티머니GO 앱에서 다시 선택",
    prefilledFields: ["departureId", "arrivalId"],
    requiresAppLoginForTerminalPrefill: true,
    reselectionRequired: ["date", "departure", "passengers", "seats", "payment"],
    continuesHeldSeat: false,
    notice:
      "티머니GO 앱에 로그인되어 있으면 출발·도착 터미널이 설정된 조회 화면을 엽니다. " +
      "로그인되어 있지 않으면 버스 홈을 엽니다. 날짜·출발편·승객·좌석·결제를 다시 선택해야 합니다. " +
      "점유한 좌석을 이어받는 기능이 아닙니다.",
  },
} as const;

export function checkoutConstraints(trip: Trip) {
  switch (trip.service) {
    case "intercity":
      return null;
    case "express": {
      const url = new URL("tmoneytia://bus/schedule");
      url.searchParams.set("startID", trip.departureId);
      url.searchParams.set("endID", trip.arrivalId);
      return {
        ...EXPRESS_CHECKOUT_CONSTRAINTS,
        mobileAlternative: { ...EXPRESS_CHECKOUT_CONSTRAINTS.mobileAlternative, url: url.href },
      };
    }
    default:
      return assertNever(trip);
  }
}

export function officialCheckout(trip: Trip) {
  switch (trip.service) {
    case "intercity":
      return {
        action: "https://txbus.t-money.co.kr/otck/readSatsFee.do",
        body: createSeatForm(trip),
      };
    case "express":
      return trip.expressIdentity.webCheckoutEligible
        ? { action: "https://www.kobus.co.kr/mrs/satschc.do", body: createExpressSeatForm(trip) }
        : null;
    default:
      return assertNever(trip);
  }
}

function assertNever(_trip: never): never {
  throw new TypeError("Unsupported checkout service");
}
