import { ConnectionError } from "./connection-sessions";

export function connectionCookie(request: Request, name: string): string | undefined {
  const entries = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith(`${name}=`));
  return entries.length === 1 ? entries[0]?.slice(name.length + 1) : undefined;
}

export async function connectionForm(
  request: Request,
  origin: string,
): Promise<Record<string, string>> {
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded"
  )
    throw new ConnectionError("csrf");
  if (!request.body) throw new ConnectionError("input");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ConnectionError("input")), 5000);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), deadline]);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        throw new ConnectionError("input");
      }
      chunks.push(result.value);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel();
    reader.releaseLock();
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  const output: Record<string, string> = {};
  for (const [key, value] of params) {
    if (Object.hasOwn(output, key)) throw new ConnectionError("input");
    Object.defineProperty(output, key, { value, enumerable: true });
  }
  return output;
}
