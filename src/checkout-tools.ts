import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { BusProvider } from "./bus-provider";
import { checkoutConstraints, officialCheckout } from "./checkout-target";
import { passengerCount, totalFare } from "./passengers";
import { ProviderError } from "./provider";
import { readAnnotations, toolResult } from "./tool-result";
import type { TripReferenceStore } from "./trip-references";

export function registerCheckoutTools(
  server: McpServer,
  options: {
    readonly provider: BusProvider;
    readonly references: TripReferenceStore;
    readonly checkoutBaseUrl: URL;
  },
): void {
  server.registerTool(
    "prepare_checkout",
    {
      description:
        "사용자가 공식 사이트 카드 결제를 선택했을 때 현재 좌석과 요금을 확인하고 연결 링크를 준비합니다. " +
        "링크에서 좌석 선택·본인인증·카드 입력·결제를 직접 완료해야 합니다. " +
        "고속버스 코버스 웹 결제는 PC 전용이며 모바일에서는 GO 앱에서 다시 선택해야 합니다. " +
        "GO 등록 카드를 자동으로 사용하지 않으며 예매 완료가 아닙니다.",
      inputSchema: z.strictObject({
        tripRef: z.uuid(),
        maxFareKrw: z.number().int().positive(),
        payment: z.strictObject({ method: z.literal("official_card") }),
      }),
      annotations: readAnnotations,
    },
    ({ tripRef, maxFareKrw, payment }) =>
      toolResult(async () => {
        const trip = options.references.get(tripRef);
        if (!trip)
          throw new ProviderError("unavailable", "출발편 참조가 만료되었습니다. 다시 조회하세요.");
        if (!officialCheckout(trip))
          throw new ProviderError("unavailable", "이 출발편은 공식 웹 예매를 지원하지 않습니다.");
        const seats = await options.provider.getSeats(trip);
        const constraints = checkoutConstraints(trip);
        const selectedTotal = totalFare(trip.passengers, seats.fareQuotes);
        if (
          selectedTotal === null ||
          selectedTotal > maxFareKrw ||
          seats.availableSeats < passengerCount(trip.passengers)
        )
          throw new ProviderError(
            "unavailable",
            "현재 요금이 상한을 초과하거나 잔여좌석이 없습니다.",
          );
        return {
          service: trip.service,
          status: "requires_user_checkout",
          payment,
          executionMode: "user_checkout",
          checkoutUrl: new URL(`/checkout/${tripRef}`, options.checkoutBaseUrl).href,
          ...(constraints ? { checkoutConstraints: constraints } : {}),
          departureName: trip.departureName,
          arrivalName: trip.arrivalName,
          departureDate: trip.departureDate,
          departureTime: trip.departureTime,
          quotedFareKrw: selectedTotal,
          totalFareKrw: selectedTotal,
          passengers: trip.passengers,
          fareQuotes: seats.fareQuotes,
          availableSeats: seats.availableSeats,
          notice: "좌석은 점유되지 않았습니다. 최종 금액은 공식 사이트에서 결제 전에 확인하세요.",
        };
      }),
  );
}
