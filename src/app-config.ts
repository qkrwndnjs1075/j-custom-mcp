import { resolve } from "node:path";
import { z } from "zod";
import { ServiceLimitsEnvironmentSchema } from "./service-limits";

export const AppConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  MCP_HOSTNAME: z.string().default("127.0.0.1"),
  MCP_ALLOWED_HOSTS: z.string().default("localhost,127.0.0.1"),
  MCP_ALLOWED_ORIGINS: z.string().default("app.vooy.com"),
  MCP_BASE_URL: z.url().optional(),
  DATA_DIRECTORY: z.string().min(1).default("data"),
  MCP_LIMITS: ServiceLimitsEnvironmentSchema,
  GO_VAULT_KEY_FILE: z.string().min(1).optional(),
  GO_APP_RESOURCES: z.string().min(1).optional(),
  GO_OS_SDK: z
    .string()
    .regex(/^\d{1,3}$/)
    .default("37"),
  GO_OS_RELEASE: z
    .string()
    .regex(/^\d{1,3}(?:\.\d+)*$/)
    .default("17"),
  GO_COUNTRY: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default("KR"),
});
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function applicationLocation(config: AppConfig) {
  const baseUrl = new URL(config.MCP_BASE_URL ?? `http://127.0.0.1:${config.PORT}`);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(baseUrl.hostname);
  if (
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    baseUrl.pathname !== "/" ||
    (baseUrl.protocol !== "https:" && !(baseUrl.protocol === "http:" && loopback)) ||
    (!config.MCP_BASE_URL && !["localhost", "127.0.0.1", "::1"].includes(config.MCP_HOSTNAME))
  )
    throw new Error("MCP_BASE_URL must be an HTTPS origin or an explicit local loopback origin.");
  return {
    baseUrl,
    dataDirectory: resolve(config.DATA_DIRECTORY),
    allowLoopbackHttp: baseUrl.protocol === "http:" && loopback,
  };
}
