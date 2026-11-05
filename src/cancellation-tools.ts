import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveService, type ServiceSource } from "./auth-policy";
import type { CancellationService } from "./cancellation-service";
import { CancellationSpecSchema } from "./cancellation-types";
import { GoCancellationSelectionSchema } from "./go-ticket-types";
import { readAnnotations, toolResult } from "./tool-result";

export function registerCancellationTools(
  server: McpServer,
  services: ServiceSource<CancellationService>,
): void {
  server.registerTool(
    "list_tickets",
    {
      description:
        "연결한 본인 계정의 지원 대상인 일반 Npay 시외·고속 승차권과 취소 요청 상태를 조회합니다. 다른 결제수단·할인 승차권은 목록에 포함하지 않습니다. uncertain은 결과 미확인이므로 새 idempotencyKey로 취소를 다시 요청하지 마세요.",
      inputSchema: z.strictObject({ service: z.enum(["intercity", "express"]) }),
      annotations: readAnnotations,
    },
    ({ service }) =>
      toolResult(async () => ({ ...(await resolveService(services).listTickets(service)) })),
  );
  server.registerTool(
    "get_cancellation_quote",
    {
      description:
        "list_tickets의 ticketRef와 전체 또는 선택 좌석으로 취소 수수료·환불 예상액을 조회합니다. 일반 Npay 승차권만 지원합니다. 수수료 확인은 preflight_only이며 서버가 보장하는 원자적 최대 수수료가 아닙니다. 실제 취소 전 사용자에게 금액과 좌석을 확인하세요.",
      inputSchema: z.strictObject({
        ticketRef: z.uuid(),
        selection: GoCancellationSelectionSchema.unwrap().shape.selection,
      }),
      annotations: readAnnotations,
    },
    ({ ticketRef, selection }) =>
      toolResult(async () => ({ ...(await resolveService(services).quote(ticketRef, selection)) })),
  );
  server.registerTool(
    "cancel_ticket",
    {
      description:
        "사용자가 승인한 quoteRef의 승차권을 acceptedFeeKrw 수수료로 사전 재확인한 뒤 취소합니다. preflight_only로 원자적 최대 수수료 보장은 아닙니다. 같은 요청은 같은 idempotencyKey UUID를 사용하세요. cancelled는 공급자 취소 내역 확인이며 Npay·은행 환불 입금 완료가 아닙니다. uncertain은 새 키로 재시도하지 말고 list_tickets로 확인하세요.",
      inputSchema: CancellationSpecSchema,
      annotations: { ...readAnnotations, readOnlyHint: false, destructiveHint: true },
    },
    (spec) => toolResult(async () => ({ ...(await resolveService(services).cancel(spec)) })),
  );
}
