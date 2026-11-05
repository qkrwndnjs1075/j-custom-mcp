import { openLocalDatabase } from "#local-runtime";
import type { SyncDatabase } from "./sql-database";

export function openOAuthDatabase(source: string | SyncDatabase): SyncDatabase {
  return typeof source === "string" ? openLocalDatabase(source, "oauth") : source;
}
