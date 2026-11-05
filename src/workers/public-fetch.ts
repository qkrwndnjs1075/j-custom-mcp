import ky, { type Options } from "ky";
import { rejectProviderRedirect } from "../http-policy";

export interface PublicFetchBinding {
  fetch(request: Request): Promise<Response>;
}

export class RegionalProviderConfigurationError extends Error {
  override readonly name = "RegionalProviderConfigurationError";
  readonly code = "configuration";
  constructor(readonly status: 400 | 413 = 400) {
    super("Invalid public provider request");
  }
}

const paths = new Set(["/mrs/readRotLinInf.ajax", "/mrs/alcnSrch.do", "/mrs/satschc.do"]);
const contentType = "application/x-www-form-urlencoded;charset=UTF-8";
const maxBodyBytes = 16_384;

function destination(request: Request, origin: string): URL {
  const url = new URL(request.url);
  if (
    url.href !== `${origin}${url.pathname}` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    request.method !== "POST" ||
    !paths.has(url.pathname)
  ) {
    throw new RegionalProviderConfigurationError();
  }
  return url;
}

async function formBody(request: Request): Promise<string> {
  if (
    !/^application\/x-www-form-urlencoded(?:;\s*charset="?utf-8"?)?$/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    throw new RegionalProviderConfigurationError();
  }
  if (Number(request.headers.get("content-length")) > maxBodyBytes)
    throw new RegionalProviderConfigurationError(413);
  const bytes = new Uint8Array(maxBodyBytes);
  let size = 0;
  const reader = request.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBodyBytes) {
          await reader.cancel();
          throw new RegionalProviderConfigurationError(413);
        }
        bytes.set(chunk.value, size - chunk.value.byteLength);
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
      bytes.subarray(0, size),
    );
    decodeURIComponent(body.replaceAll("+", " "));
    if ([...new URLSearchParams(body).keys()].some((key) => key.length === 0))
      throw new RegionalProviderConfigurationError();
    return body;
  } catch (error) {
    if (error instanceof URIError || error instanceof TypeError)
      throw new RegionalProviderConfigurationError();
    throw error;
  }
}

export function createRegionalProviderFetch(
  binding: PublicFetchBinding,
): NonNullable<Options["fetch"]> {
  return async (input, init) => {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch (error) {
      if (error instanceof TypeError) throw new RegionalProviderConfigurationError();
      throw error;
    }
    const url = destination(request, "https://www.kobus.co.kr");
    const body = await formBody(request);
    return binding.fetch(
      new Request(`https://provider.internal${url.pathname}`, {
        method: "POST",
        headers: { "content-type": contentType },
        body,
        signal: request.signal,
        redirect: "manual",
      }),
    );
  };
}

export async function fetchPublicProvider(request: Request): Promise<Response> {
  let url: URL;
  let body: string;
  try {
    url = destination(request, "https://provider.internal");
    body = await formBody(request);
  } catch (error) {
    if (error instanceof RegionalProviderConfigurationError)
      return new Response(error.message, { status: error.status });
    throw error;
  }
  return ky.post(`https://www.kobus.co.kr${url.pathname}`, {
    body,
    headers: {
      "content-type": contentType,
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.kobus.co.kr/mrs/rotinf.do",
    },
    signal: request.signal,
    timeout: 30_000,
    retry: 0,
    redirect: "manual",
    throwHttpErrors: false,
    hooks: { afterResponse: [rejectProviderRedirect] },
  });
}
