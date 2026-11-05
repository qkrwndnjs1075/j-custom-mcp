import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PUBLIC_TOOL_NAMES } from "./auth-policy";
import { EXPRESS_CHECKOUT_CONSTRAINTS } from "./checkout-target";
import { GO_PURCHASE_CAPABILITIES } from "./go-purchase";
import type { ServiceLimits } from "./service-limits";
import { readAnnotations, toolResult } from "./tool-result";

export function registerCapabilityTools(
  server: McpServer,
  options: {
    readonly limits: ServiceLimits;
    readonly purchaseEnabled: boolean;
    readonly cancellationEnabled?: boolean;
    readonly watchesEnabled: boolean;
    readonly checkoutEnabled: boolean;
    readonly connectionEnabled: boolean;
    readonly connectionUrl?: string;
  },
): void {
  server.registerTool(
    "get_service_capabilities",
    {
      description:
        "이 연결에서 실행 가능한 승객 유형·결제·할인·예매 도구와 운영 한도를 조회합니다. " +
        "VOOY는 사용자의 선택을 명시적인 인자로 전달하고, 지원하지 않는 선택을 다른 값으로 대체하지 마세요.",
      inputSchema: z.strictObject({}),
      annotations: { ...readAnnotations, openWorldHint: false },
    },
    () =>
      toolResult(async () => ({
        service: "tmoney_go_bus",
        services: [
          { service: "intercity", label: "시외버스", terminalCodeDigits: 7, provider: "txbus" },
          { service: "express", label: "고속버스", terminalCodeDigits: 3, provider: "kobus" },
        ],
        timezone: "Asia/Seoul",
        passengers: ["adult", "student", "child"],
        fareSource: "provider_quote",
        paymentOptionsTool: "get_payment_options",
        query: {
          rankingKeys: ["preferred_time", "fare", "departure_time"],
          journeyRankingKeys: ["total_fare", "total_preferred_time", "leg_order"],
          requires: ["service", "passengers", "time"],
          crossServiceTransfers: "unsupported",
        },
        booking: options.purchaseEnabled
          ? {
              ...GO_PURCHASE_CAPABILITIES,
              paymentAvailabilityTool: "get_payment_options",
              executionMode: "automatic",
              authorizationVersion: 2,
              directTool: "book_trip",
              watchTool: "create_booking_request",
              seatPolicies: ["only", "first_available"],
              serviceSelection: {
                book_trip: "tripRef",
                create_booking_request: "criteria.service",
              },
              requires: [
                "passengers",
                "seatPolicy",
                "payment",
                "discounts",
                "maxFareKrw",
                "expiresAt",
              ],
            }
          : null,
        ticketCancellation: options.cancellationEnabled
          ? {
              services: ["intercity", "express"],
              paymentMethods: ["naver_pay_auto"],
              selectionModes: ["all", "seats"],
              tools: ["list_tickets", "get_cancellation_quote", "cancel_ticket"],
              feeConsent: "preflight_only",
              atomicMaximumFee: false,
              confirmation: "provider_cancellation_history",
              bankSettlementConfirmed: false,
              uncertainRetry: "same_idempotency_key_only",
              unsupported: [
                "other_payments",
                "complex_payment",
                "mileage",
                "coupon",
                "discounted_round_trip",
                "combined_discount",
              ],
            }
          : null,
        officialCheckout: options.checkoutEnabled
          ? {
              tool: "prepare_checkout",
              paymentMethods: ["official_card"],
              executionMode: "user_checkout",
              serviceConstraints: { express: EXPRESS_CHECKOUT_CONSTRAINTS },
            }
          : null,
        authentication: {
          publicTools: PUBLIC_TOOL_NAMES,
          publicToolConditions: { get_payment_options: "tripRef_only" },
          protectedToolChallenge: "oauth_http_401",
          promptOwner: "mcp_client",
          methods: options.connectionEnabled ? ["toss"] : [],
          configured: options.connectionEnabled,
          existingMemberRequired: true,
          ...(options.connectionUrl ? { connectionUrl: options.connectionUrl } : {}),
        },
        alerts: options.watchesEnabled
          ? { tool: "check_alerts", transport: "client_pull", userNotificationOwner: "client" }
          : null,
        limits: options.limits,
      })),
  );
}
