import { AppConfigSchema } from "./app-config";
import { createApplication } from "./application";
import { runScheduler } from "./scheduler";

const config = AppConfigSchema.parse(process.env);
const application = await createApplication(config);
const server = Bun.serve({
  hostname: config.MCP_HOSTNAME,
  port: config.PORT,
  fetch: application.fetch,
});
const shutdown = new AbortController();
const stop = () => shutdown.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  await runScheduler({
    tick: application.tick,
    limits: config.MCP_LIMITS,
    signal: shutdown.signal,
  });
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  await server.stop();
  await application.close();
}
