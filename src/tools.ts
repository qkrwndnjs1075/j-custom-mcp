import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AccountStatusService } from "./account-tools";
import type { ServiceSource } from "./auth-policy";
import { type BookingServices, registerBookingTools } from "./booking-tools";
import { type BusProvider, TerminalSearchSchema, TripSearchSchema } from "./bus-provider";
import type { CancellationService } from "./cancellation-service";
import { registerCancellationTools } from "./cancellation-tools";
import { registerCapabilityTools } from "./capability-tools";
import { registerCheckoutTools } from "./checkout-tools";
import { registerJourneyTools } from "./journey-tools";
import { totalFare } from "./passengers";
import { registerPaymentTools } from "./payment-tools";
import { ProviderError } from "./provider";
import { TripQueryService } from "./query";
import { registerRequestTools } from "./request-tools";
import { DEFAULT_SERVICE_LIMITS, type ServiceLimits } from "./service-limits";
import { readAnnotations as annotations, toolResult as result } from "./tool-result";
import type { TripReferenceStore } from "./trip-references";
import { registerWatchTools, type WatchServices } from "./watch-tools";

export function createBusServer(services: {
  readonly provider: BusProvider;
  readonly references: TripReferenceStore;
  readonly checkoutBaseUrl?: URL;
  readonly watches?: ServiceSource<WatchServices>;
  readonly query?: TripQueryService;
  readonly account?: ServiceSource<AccountStatusService>;
  readonly bookings?: ServiceSource<BookingServices>;
  readonly cancellations?: ServiceSource<CancellationService>;
  readonly connectionUrl?: string;
  readonly limits?: ServiceLimits;
  readonly connectionEnabled?: boolean;
}): McpServer {
  const { provider, references, checkoutBaseUrl, watches } = services;
  const server = new McpServer(
    { name: "joowon-custom-mcp", version: "0.1.0" },
    {
      instructions:
        "티머니GO 시외·고속버스 실행 도구입니다. service=intercity는 시외, service=express는 고속입니다. VOOY가 사용자의 승객·좌석·결제·정렬 조건을 명시적으로 전달합니다. get_service_capabilities로 지원 범위를, get_payment_options({tripRef})로 해당 편의 결제 경로를, get_payment_options({service})로 연결 계정의 상태를 확인하세요. 두 입력은 함께 전달할 수 없으며 service 조회에는 로그인이 필요합니다. list_requests는 본인의 감시·자동예매 요청을 함께 조회합니다. 조회와 공식 사이트 카드 결제 링크 준비는 계정 연결 없이 가능합니다. 날짜와 시각은 한국시간입니다. " +
        (services.bookings
          ? "create_booking_request는 연결한 본인 계정의 Npay 결제를 포함합니다. 노선·날짜·시간·최대요금·유효시간에 대한 사용자의 명시적 승인을 먼저 확인하세요. 같은 요청에는 같은 idempotencyKey를 사용하세요. 요청 생성과 좌석 점유는 예매 완료가 아니며 stage=booked만 발권 확인입니다. uncertain 상태를 새 요청으로 재결제하지 마세요. "
          : "이 연결에는 자동예매 실행이 설정되지 않았습니다. ") +
        "보호된 도구의 HTTP 401 인증 요청은 MCP 클라이언트가 처리합니다. 사용자 ID나 인증정보를 대화에 요구하지 마세요. get_payment_options의 executionSupported와 status를 확인하고 사용자가 선택한 결제 경로를 전달하세요. 조회 결과와 공식 결제 링크를 예약 완료로 설명하지 마세요.",
    },
  );
  server.registerTool(
    "search_terminals",
    {
      description:
        "시외·고속버스 종류를 지정한 터미널 검색. 도착지를 검색할 때는 선택한 출발 터미널 ID를 전달합니다.",
      inputSchema: TerminalSearchSchema,
      annotations,
    },
    (input) =>
      result(async () => ({
        terminals: await provider.searchTerminals({
          service: input.service,
          query: input.query,
          ...(input.departureId ? { departureId: input.departureId } : {}),
        }),
      })),
  );
  server.registerTool(
    "search_trips",
    {
      description:
        "시외·고속버스 출발편·요금·잔여좌석 조회. null 요금은 get_seats로 확인하세요. 다음 페이지는 같은 조건과 continuation으로 조회합니다. " +
        "페이지 경계에서 같은 편이 반복될 수 있으므로 tripKey로 구분하세요. tripRef 유효시간은 get_service_capabilities의 limits에 표시됩니다.",
      inputSchema: TripSearchSchema,
      annotations,
    },
    (input) =>
      result(async () => {
        const page = await provider.searchTripPage(input);
        return {
          timezone: "Asia/Seoul",
          service: input.service,
          passengers: input.passengers,
          continuation: page.continuation,
          coverage: page.coverage,
          emptyStatus: page.emptyStatus,
          unavailable: page.unavailable,
          trips: page.trips.map((trip) => ({
            service: trip.service,
            tripKey: trip.tripKey,
            tripRef: references.add(trip),
            departureName: trip.departureName,
            arrivalName: trip.arrivalName,
            departureDate: trip.departureDate,
            departureTime: trip.departureTime,
            carrierName: trip.carrierName,
            busClassName: trip.busClassName,
            adultFareKrw: trip.adultFareKrw,
            totalFareKrw: trip.totalFareKrw,
            fareQuotes: trip.fareQuotes,
            remainingSeats: trip.remainingSeats,
            totalSeats: trip.totalSeats,
            estimatedDurationMinutes: trip.estimatedDurationMinutes,
            availability: trip.availability,
          })),
        };
      }),
  );
  server.registerTool(
    "get_seats",
    {
      description:
        "search_trips의 tripRef로 현재 좌석과 요금을 다시 조회합니다. 좌석을 점유하지 않습니다.",
      inputSchema: z.object({ tripRef: z.uuid() }),
      annotations,
    },
    ({ tripRef }) => {
      const trip = references.get(tripRef);
      if (!trip) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "출발편 참조가 없거나 만료되었습니다. search_trips를 다시 호출하세요.",
            },
          ],
        };
      }
      return result(async () => {
        const seats = await provider.getSeats(trip);
        const totalFareKrw = totalFare(trip.passengers, seats.fareQuotes);
        if (
          !references.updateQuote(tripRef, {
            adultFareKrw: seats.adultFareKrw,
            fareQuotes: seats.fareQuotes,
            totalFareKrw,
            remainingSeats: seats.availableSeats,
            totalSeats: seats.totalSeats,
          })
        )
          throw new ProviderError("unavailable", "Trip reference expired while reading fares");
        return {
          service: trip.service,
          tripRef,
          passengers: trip.passengers,
          ...seats,
          totalFareKrw,
        };
      });
    },
  );
  if (checkoutBaseUrl) registerCheckoutTools(server, { provider, references, checkoutBaseUrl });
  registerPaymentTools(server, {
    references,
    checkoutEnabled: checkoutBaseUrl !== undefined,
    purchaseEnabled: services.bookings !== undefined,
    ...(services.account ? { account: services.account } : {}),
    ...(services.connectionUrl ? { connectionUrl: services.connectionUrl } : {}),
  });
  const limits = services.limits ?? DEFAULT_SERVICE_LIMITS;
  registerCapabilityTools(server, {
    limits,
    purchaseEnabled: services.bookings !== undefined,
    watchesEnabled: watches !== undefined,
    cancellationEnabled: services.cancellations !== undefined,
    checkoutEnabled: checkoutBaseUrl !== undefined,
    connectionEnabled: services.connectionEnabled === true,
    ...(services.connectionUrl ? { connectionUrl: services.connectionUrl } : {}),
  });
  registerJourneyTools(
    server,
    services.query ?? new TripQueryService(provider, Date.now, limits),
    references,
  );
  if (watches) registerWatchTools(server, watches);
  if (watches || services.bookings)
    registerRequestTools(server, {
      ...(watches ? { watches } : {}),
      ...(services.bookings ? { bookings: services.bookings } : {}),
    });
  if (services.bookings) registerBookingTools(server, services.bookings, { references, provider });
  if (services.cancellations) registerCancellationTools(server, services.cancellations);
  return server;
}
