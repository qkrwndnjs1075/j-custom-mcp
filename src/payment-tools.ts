import type { McpServer } from "@modelcontextprotocol/server";
import type { AccountStatusService } from "./account-tools";
import { AuthenticationRequiredError, resolveService, type ServiceSource } from "./auth-policy";
import type { BusService } from "./bus-service";
import { checkoutConstraints, officialCheckout } from "./checkout-target";
import { GoAccountError, type GoPaymentMethodStatus } from "./go-account";
import { canUseAutomaticNpay } from "./go-payment-methods";
import { PaymentQuerySchema } from "./payment-query";
import { ProviderError } from "./provider";
import { readAnnotations, toolResult } from "./tool-result";
import type { TripReferenceStore } from "./trip-references";

type AccountOptions = {
  readonly account?: ServiceSource<AccountStatusService>;
  readonly connectionUrl?: string;
};
type PaymentAccount = {
  readonly connection: "connected" | "requires_account" | "not_configured" | "unknown";
  readonly methods: readonly GoPaymentMethodStatus[];
  readonly error?: string;
};

async function paymentAccount(
  options: AccountOptions,
  service: BusService,
): Promise<PaymentAccount> {
  if (!options.account) return { connection: "not_configured", methods: [] };
  try {
    const status = await resolveService(options.account).getStatus(service);
    return status.connection === "connected"
      ? { connection: "connected", methods: status.paymentMethods }
      : {
          connection: status.connection === "not_connected" ? "requires_account" : "not_configured",
          methods: [],
        };
  } catch (error) {
    if (
      error instanceof AuthenticationRequiredError ||
      (error instanceof GoAccountError && error.code === "authentication_required")
    )
      return { connection: "requires_account", methods: [] };
    if (error instanceof GoAccountError)
      return { connection: "unknown", methods: [], error: error.code };
    throw error;
  }
}

function automaticStatus(account: PaymentAccount) {
  if (account.connection !== "connected") return account.connection;
  if (canUseAutomaticNpay(account.methods)) return "available";
  const method = account.methods.find((item) => item.method === "naver_pay_auto");
  if (method?.displayed === false) return "unavailable";
  if (method?.registration === "not_registered") return "not_registered";
  if (method?.billingReferenceAvailable === false) return "unavailable";
  return "unknown";
}

export function registerPaymentTools(
  server: McpServer,
  options: AccountOptions & {
    readonly references: TripReferenceStore;
    readonly checkoutEnabled: boolean;
    readonly purchaseEnabled: boolean;
  },
): void {
  server.registerTool(
    "get_payment_options",
    {
      description:
        "출발편의 결제 경로와 연결 계정의 결제수단 등록 상태를 조회합니다. " +
        "tripRef 또는 service 중 하나만 입력하세요. service 조회는 인증이 필요하며 출발편 없이 계정 상태를 반환합니다. " +
        "공식 사이트 카드 결제는 직접 완료해야 하며, Npay 자동결제는 계정 연결과 사용 가능 여부 확인이 필요합니다. " +
        "등록되어 있어도 executionSupported=false인 수단은 이 MCP로 실행할 수 없습니다. 결제수단을 임의로 대신 선택하지 마세요.",
      inputSchema: PaymentQuerySchema,
      annotations: readAnnotations,
    },
    (query) =>
      toolResult(async () => {
        if ("service" in query) {
          try {
            return {
              service: query.service,
              ...(options.account
                ? await resolveService(options.account).getStatus(query.service)
                : { connection: "not_configured" }),
              ...(options.connectionUrl ? { connectionUrl: options.connectionUrl } : {}),
            };
          } catch (error) {
            if (
              error instanceof GoAccountError &&
              error.code === "authentication_required" &&
              options.connectionUrl
            )
              throw new AuthenticationRequiredError(options.connectionUrl);
            throw error;
          }
        }
        const { tripRef } = query;
        const trip = options.references.get(tripRef);
        if (!trip)
          throw new ProviderError("unavailable", "출발편 참조가 만료되었습니다. 다시 조회하세요.");
        const account = await paymentAccount(options, trip.service);
        const constraints = checkoutConstraints(trip);
        return {
          service: trip.service,
          tripRef,
          options: [
            ...(options.checkoutEnabled
              ? [
                  {
                    payment: { method: "official_card" },
                    label: "공식 사이트 카드 결제",
                    status: officialCheckout(trip)
                      ? constraints?.requiresDesktop
                        ? "requires_desktop"
                        : "available"
                      : "unavailable",
                    ...(constraints ? { checkoutConstraints: constraints } : {}),
                    executionMode: "user_checkout",
                    requiresGoAccount: false,
                    tool: "prepare_checkout",
                  },
                ]
              : []),
            ...(options.purchaseEnabled
              ? [
                  {
                    payment: { method: "naver_pay_auto" },
                    label: "등록된 Npay 자동결제",
                    status: automaticStatus(account),
                    executionMode: "automatic",
                    requiresGoAccount: true,
                    tool: "book_trip",
                    watchTool: "create_booking_request",
                  },
                ]
              : []),
          ],
          registeredMethods: account.methods.map((method) => ({
            ...method,
            executionSupported: options.purchaseEnabled && method.method === "naver_pay_auto",
          })),
          account: {
            connection: account.connection,
            ...(account.error ? { error: account.error } : {}),
            ...(options.connectionUrl ? { connectionUrl: options.connectionUrl } : {}),
          },
        };
      }),
  );
}
