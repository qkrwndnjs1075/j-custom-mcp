import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveService, type ServiceSource } from "./auth-policy";
import type { BookingServices } from "./booking-tools";
import { readAnnotations, toolResult } from "./tool-result";
import type { WatchServices } from "./watch-tools";

export function registerRequestTools(
  server: McpServer,
  services: {
    readonly watches?: ServiceSource<WatchServices>;
    readonly bookings?: ServiceSource<BookingServices>;
  },
): void {
  server.registerTool(
    "list_requests",
    {
      description:
        "본인의 감시와 자동예매 요청을 함께 조회합니다. 감시 조건·다음 확인 시각·오류와 예매 단계를 확인할 수 있습니다. " +
        "조회는 감시나 결제를 실행하지 않습니다. uncertain은 결과 미확인 상태이며 다시 결제하지 마세요.",
      inputSchema: z.strictObject({}),
      annotations: { ...readAnnotations, openWorldHint: false },
    },
    () =>
      toolResult(async () => ({
        watches: services.watches ? resolveService(services.watches).store.list() : [],
        bookings: services.bookings ? resolveService(services.bookings).store.list() : [],
        delivery: "inbox_only",
      })),
  );
}
