import { afterEach, expect, spyOn, test } from "bun:test";
import {
  createRegionalProviderFetch,
  fetchPublicProvider,
  RegionalProviderConfigurationError,
} from "../src/workers/public-fetch";

const originalFetch = globalThis.fetch;
function wireFetch(implementation: (request: Request) => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => implementation(new Request(input, init)),
      { preconnect: originalFetch.preconnect },
    ),
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(url: string, body = "deprCd=010&arvlCd=020", headers: HeadersInit = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", ...headers },
    body,
  });
}

test("regional wrapper and handler preserve public form and stream HTTP errors without forwarding credentials", async () => {
  const wire: Request[] = [];
  const fake = wireFetch(async (input) => {
    wire.push(input);
    return new Response("unparsed upstream body", {
      status: 503,
      headers: { "content-type": "text/html" },
    });
  });
  const hops: Request[] = [];
  const regional = createRegionalProviderFetch({
    async fetch(internal) {
      hops.push(internal.clone());
      return fetchPublicProvider(internal);
    },
  });
  try {
    const response = await regional(
      request("https://www.kobus.co.kr/mrs/alcnSrch.do", "deprCd=010&arvlCd=020", {
        authorization: "Bearer private",
        cookie: "session=private",
        "x-secret": "private",
        referer: "https://untrusted.example",
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("unparsed upstream body");
    expect(hops).toHaveLength(1);
    expect(hops[0]?.url).toBe("https://provider.internal/mrs/alcnSrch.do");
    const hopHeaders: string[] = [];
    hops[0]?.headers.forEach((_value, key) => {
      hopHeaders.push(key);
    });
    expect(hopHeaders).toEqual(["content-type"]);
    expect(wire).toHaveLength(1);
    const upstream = wire[0];
    if (!upstream) throw new TypeError("Missing wire request");
    expect(upstream.url).toBe("https://www.kobus.co.kr/mrs/alcnSrch.do");
    expect(await upstream.text()).toBe("deprCd=010&arvlCd=020");
    expect(upstream.headers.get("authorization")).toBeNull();
    expect(upstream.headers.get("cookie")).toBeNull();
    expect(upstream.headers.get("x-secret")).toBeNull();
    expect(upstream.headers.get("user-agent")).toBe("Mozilla/5.0");
    expect(upstream.headers.get("referer")).toBe("https://www.kobus.co.kr/mrs/rotinf.do");
    expect(upstream.redirect).toBe("manual");
  } finally {
    fake.mockRestore();
  }
});

for (const suffix of ["?token=private", "?", "#fragment", "#"]) {
  test(`wrapper rejects URL suffix ${suffix} before binding`, async () => {
    let calls = 0;
    const regional = createRegionalProviderFetch({
      async fetch() {
        calls++;
        return new Response();
      },
    });
    await expect(
      regional(request(`https://www.kobus.co.kr/mrs/alcnSrch.do${suffix}`)),
    ).rejects.toBeInstanceOf(RegionalProviderConfigurationError);
    expect(calls).toBe(0);
  });
}

for (const url of [
  "http://www.kobus.co.kr/mrs/alcnSrch.do",
  "https://evil.example/mrs/alcnSrch.do",
  "https://www.kobus.co.kr:444/mrs/alcnSrch.do",
  "https://www.kobus.co.kr/mrs/payment.do",
  "https://tiaapi.tmoney.co.kr/toss/auth",
]) {
  test(`wrapper rejects nonpublic target ${url}`, async () => {
    let calls = 0;
    const regional = createRegionalProviderFetch({
      async fetch() {
        calls++;
        return new Response();
      },
    });
    await expect(regional(request(url))).rejects.toBeInstanceOf(RegionalProviderConfigurationError);
    expect(calls).toBe(0);
  });
}

test("handler rejects wrong origin, methods, non-form content and malformed forms without outbound requests", async () => {
  const fake = wireFetch(async () => {
    throw new TypeError("Unexpected outbound");
  });
  const inputs = [
    request("https://public.example/mrs/alcnSrch.do"),
    new Request("https://provider.internal/mrs/alcnSrch.do"),
    request("https://provider.internal/mrs/alcnSrch.do", "{}", {
      "content-type": "application/json",
    }),
    request("https://provider.internal/mrs/alcnSrch.do", "value=%FF"),
    request("https://provider.internal/mrs/alcnSrch.do", "value=%GG"),
    request("https://provider.internal/mrs/alcnSrch.do", "=nameless"),
    request("https://provider.internal/mrs/payment.do"),
    request("https://provider.internal:444/mrs/alcnSrch.do"),
  ];
  try {
    for (const input of inputs) expect((await fetchPublicProvider(input)).status).toBe(400);
    expect(fake).not.toHaveBeenCalled();
  } finally {
    fake.mockRestore();
  }
});

test("form limit counts streamed bytes and accepts exactly 16 KiB", async () => {
  const fake = wireFetch(async () => new Response("ok"));
  const regional = createRegionalProviderFetch({ fetch: fetchPublicProvider });
  try {
    expect(
      (await regional(request("https://www.kobus.co.kr/mrs/satschc.do", `a=${"x".repeat(16382)}`)))
        .status,
    ).toBe(200);
    const oversized = () =>
      new Request("https://provider.internal/mrs/satschc.do", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`a=${"x".repeat(16383)}`));
            controller.close();
          },
        }),
      });
    expect((await fetchPublicProvider(oversized())).status).toBe(413);
    await expect(
      regional(request("https://www.kobus.co.kr/mrs/satschc.do", `a=${"x".repeat(16383)}`)),
    ).rejects.toBeInstanceOf(RegionalProviderConfigurationError);
    expect(fake).toHaveBeenCalledTimes(1);
  } finally {
    fake.mockRestore();
  }
});

test("handler rejects provider redirects instead of following them", async () => {
  const fake = wireFetch(
    async () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
  );
  try {
    await expect(
      fetchPublicProvider(request("https://provider.internal/mrs/readRotLinInf.ajax", "")),
    ).rejects.toThrow("Provider redirects are not permitted");
    expect(fake).toHaveBeenCalledTimes(1);
  } finally {
    fake.mockRestore();
  }
});
