import type { McpServer } from "@modelcontextprotocol/server";
import type { TripQueryService } from "./query";
import { JourneySearchSchema } from "./query-types";
import { readAnnotations, toolResult } from "./tool-result";
import type { TripReferenceStore } from "./trip-references";

export function registerJourneyTools(
  server: McpServer,
  query: TripQueryService,
  references: TripReferenceStore,
): void {
  server.registerTool(
    "find_journeys",
    {
      description:
        "여러 구간의 요금·시간·잔여좌석 조건을 비교합니다. legs의 preferredTime으로 가까운 대안을 찾고 " +
        "adjacentSeats로 실제 붙어 있는 좌석을 찾습니다. 요금은 지정한 승객 구성의 합계이며 ranking 순서로 비교합니다. minSeats는 잔여좌석 조건입니다. " +
        "complete=false이면 전체 최저가나 조건에 맞는 편이 없다고 단정하지 마세요.",
      inputSchema: JourneySearchSchema,
      annotations: readAnnotations,
    },
    (input) =>
      toolResult(async () => {
        const result = await query.findJourneys(input);
        return {
          ...result,
          timezone: "Asia/Seoul",
          journeys: result.journeys.map((journey) => ({
            totalFareKrw: journey.totalFareKrw,
            legs: journey.legs.map(({ trip, adjacentSeatGroups }) => ({
              service: trip.service,
              tripRef: references.add(trip),
              tripKey: trip.tripKey,
              departureName: trip.departureName,
              arrivalName: trip.arrivalName,
              departureDate: trip.departureDate,
              departureTime: trip.departureTime,
              carrierName: trip.carrierName,
              busClassName: trip.busClassName,
              adultFareKrw: trip.adultFareKrw,
              passengers: trip.passengers,
              totalFareKrw: trip.totalFareKrw,
              fareQuotes: trip.fareQuotes,
              remainingSeats: trip.remainingSeats,
              estimatedDurationMinutes: trip.estimatedDurationMinutes,
              ...(adjacentSeatGroups ? { adjacentSeatGroups } : {}),
            })),
          })),
        };
      }),
  );
}
