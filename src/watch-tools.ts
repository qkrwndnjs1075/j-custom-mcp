import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveService, type ServiceSource } from "./auth-policy";
import { readAnnotations, toolResult } from "./tool-result";
import type { WatchRunner } from "./watch-runner";
import type { WatchStore } from "./watch-store";
import { AlertQuerySchema, WatchSpecSchema } from "./watch-types";

export type WatchServices = {
  readonly store: WatchStore;
  readonly runner: WatchRunner;
};

export function registerWatchTools(
  server: McpServer,
  services: ServiceSource<WatchServices>,
): void {
  server.registerTool(
    "watch_trips",
    {
      description:
        "명시한 승객·조회 간격·notification·retryPolicy로 빈자리 또는 예매 가능한 편을 감시합니다. " +
        "expiresAt은 한국시간 오프셋을 포함한 종료 시각입니다. 결과는 check_alerts로 읽고 사용자에게 전달하는 방식은 VOOY가 결정합니다.",
      inputSchema: WatchSpecSchema,
      annotations: { ...readAnnotations, readOnlyHint: false, openWorldHint: false },
    },
    (spec) =>
      toolResult(async () => ({
        ...resolveService(services).store.create(spec),
        delivery: "inbox_only",
      })),
  );

  server.registerTool(
    "cancel_watch",
    {
      description: "감시를 중단합니다. 버스 승차권을 취소하는 기능이 아닙니다.",
      inputSchema: z.object({ watchId: z.uuid() }),
      annotations: {
        ...readAnnotations,
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    ({ watchId }) =>
      toolResult(async () => ({
        watchId,
        cancelled: resolveService(services).store.cancel(watchId),
      })),
  );

  server.registerTool(
    "check_alerts",
    {
      description:
        "기한이 된 감시를 실행하고 서버 알림함을 조회합니다. 반복 호출에는 이전 nextCursor를 after로 전달하세요. " +
        "조회는 채팅 전송을 뜻하지 않으며 gap=true이면 보존 기간을 벗어난 기록이 있습니다.",
      inputSchema: AlertQuerySchema,
      annotations: { ...readAnnotations, readOnlyHint: false },
    },
    (query) =>
      toolResult(async () => ({
        checks: await resolveService(services).runner.tick(),
        ...resolveService(services).store.getAlerts(query),
        delivery: "inbox_only",
      })),
  );
}
