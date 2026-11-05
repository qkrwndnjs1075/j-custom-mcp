export class LocalRuntimeUnavailableError extends Error {
  override readonly name = "LocalRuntimeUnavailableError";
  constructor() {
    super(
      "Local filesystem configuration is unavailable in Workers; inject durable storage and vault key.",
    );
  }
}
export function openLocalDatabase(
  _path: string,
  _kind: "booking" | "oauth" | "watch" | "users",
): never {
  throw new LocalRuntimeUnavailableError();
}
export function loadVaultKey(_keyPath: string, _existingDatabase: boolean): never {
  throw new LocalRuntimeUnavailableError();
}
export function localFileExists(_path: string): never {
  throw new LocalRuntimeUnavailableError();
}
export function privateVaultFile(_path: string): never {
  throw new LocalRuntimeUnavailableError();
}
export async function loadGoRefreshSalt(_path: string): Promise<string> {
  throw new LocalRuntimeUnavailableError();
}
export function localBookingIp(): string {
  return "";
}
