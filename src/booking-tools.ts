import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveService, type ServiceSource } from "./auth-policy";
import type { BookingRunner } from "./booking-runner";
import type { BookingStore } from "./booking-store";
import {
  BookingError,
  BookingSpecSchema,
  DiscountChoiceSchema,
  PaymentChoiceSchema,
  SeatPolicySchema,
} from "./booking-types";
import type { BusProvider } from "./bus-provider";
import { PassengersSchema, passengerCount, totalFare } from "./passengers";
import { readAnnotations, toolResult } from "./tool-result";
import type { TripReferenceStore } from "./trip-references";

export type BookingServices = {
  readonly store: BookingStore;
  readonly runner: BookingRunner;
};
type BookingTripLookup = {
  readonly references: TripReferenceStore;
  readonly provider: Pick<BusProvider, "getSeats">;
};

async function bookingResult(operation: () => Promise<Record<string, unknown>>) {
  try {
    return await toolResult(operation);
  } catch (error) {
    if (!(error instanceof BookingError)) throw error;
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ error: error.code, message: error.message }),
        },
      ],
    };
  }
}

export function registerBookingTools(
  server: McpServer,
  services: ServiceSource<BookingServices>,
  { references, provider }: BookingTripLookup,
): void {
  server.registerTool(
    "create_booking_request",
    {
      description:
        "명시한 승객, 좌석 정책, 결제 방식과 할인 정책으로 자동예매를 승인합니다. " +
        "조건에 맞는 빈자리를 찾으면 좌석 점유와 결제·발권을 시도합니다. " +
        "idempotencyKey는 동일 요청 재시도에 같은 UUID를 사용하세요. criteria.maxFareKrw는 승인할 최대 요금, " +
        "expiresAt은 한국시간 오프셋을 포함한 승인 종료 시각이며 출발 시각보다 늦을 수 없습니다. " +
        "요청 생성은 예매 완료가 아닙니다. stage=booked인 확인 결과만 예매 완료로 설명하세요.",
      inputSchema: BookingSpecSchema,
      annotations: { ...readAnnotations, readOnlyHint: false, destructiveHint: true },
    },
    (spec) =>
      bookingResult(async () => ({
        ...(await resolveService(services).runner.create(spec)),
      })),
  );

  server.registerTool(
    "book_trip",
    {
      description:
        "조회한 tripRef의 운행만 즉시 한 번 예매합니다. 승객별 좌석과 결제 조건을 명시하세요. 좌석이 없으면 대기하거나 다른 운행을 선택하지 않습니다. stage=booked만 발권 확인입니다.",
      inputSchema: z.strictObject({
        version: z.literal(2),
        tripRef: z.uuid(),
        idempotencyKey: z.uuid(),
        passengers: PassengersSchema,
        seatPolicy: SeatPolicySchema,
        payment: PaymentChoiceSchema,
        discounts: DiscountChoiceSchema,
        maxFareKrw: z.number().int().positive(),
        intervalSeconds: z.number().int().positive(),
        expiresAt: z.iso.datetime({ offset: true }),
      }),
      annotations: { ...readAnnotations, readOnlyHint: false, destructiveHint: true },
    },
    (input) =>
      bookingResult(async () => {
        let trip = references.get(input.tripRef);
        if (!trip) throw new BookingError("invalid_reference");
        if (trip.totalFareKrw === null) {
          const seats = await provider.getSeats(trip);
          const totalFareKrw = totalFare(trip.passengers, seats.fareQuotes);
          if (
            totalFareKrw === null ||
            !references.updateQuote(input.tripRef, {
              adultFareKrw: seats.adultFareKrw,
              fareQuotes: seats.fareQuotes,
              totalFareKrw,
              remainingSeats: seats.availableSeats,
              totalSeats: seats.totalSeats,
            })
          )
            throw new BookingError("invalid_reference");
          trip = references.get(input.tripRef);
          if (!trip) throw new BookingError("invalid_reference");
        }
        const date = `${trip.departureDate.slice(0, 4)}-${trip.departureDate.slice(4, 6)}-${trip.departureDate.slice(6)}`;
        const time = `${trip.departureTime.slice(0, 2)}:${trip.departureTime.slice(2, 4)}`;
        const spec = BookingSpecSchema.safeParse({
          version: input.version,
          idempotencyKey: input.idempotencyKey,
          seatPolicy: input.seatPolicy,
          payment: input.payment,
          discounts: input.discounts,
          expiresAt: input.expiresAt,
          intervalSeconds: input.intervalSeconds,
          criteria: {
            service: trip.service,
            departureId: trip.departureId,
            arrivalId: trip.arrivalId,
            date,
            time,
            endTime: time,
            passengers: input.passengers,
            minSeats: passengerCount(input.passengers),
            maxFareKrw: input.maxFareKrw,
            ranking: ["departure_time"],
          },
        });
        if (!spec.success) throw new BookingError("invalid_spec");
        return { ...(await resolveService(services).runner.createExact(spec.data, trip)) };
      }),
  );

  server.registerTool(
    "cancel_booking_request",
    {
      description:
        "아직 빈자리를 감시하는 watching 상태의 자동예매 승인만 중단합니다. 결제 진행 중인 요청이나 발권된 승차권을 취소하지 않습니다.",
      inputSchema: z.strictObject({ bookingId: z.uuid() }),
      annotations: {
        ...readAnnotations,
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    ({ bookingId }) =>
      bookingResult(async () => ({
        bookingId,
        ...resolveService(services).store.cancel(bookingId),
      })),
  );
}
