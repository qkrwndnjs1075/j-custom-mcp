import { afterEach, expect, test } from "bun:test";
import { GoAuthError, TmoneyGoAuthClient } from "../src/go-auth";

const device = { uuid: "synthetic-device", osVer: "34" };
const identity = {
  triggerType: "APP_SCHEME",
  userName: "Synthetic User",
  userPhone: "01000000000",
  userBirthday: "19900101",
} as const;
const secret = "synthetic-token-must-not-leak";
const completion = { txId: "synthetic-tx", reqSno: "0007", moappMbrsSno: "123456789" };
const listeners: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of listeners.splice(0)) server.stop(true);
});

function fixture(handler: (request: Request) => Response | Promise<Response>, timeoutMs = 1000) {
  const urls: string[] = [];
  const requests: Request[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  listeners.push(server);
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      urls.push(request.url);
      requests.push(request.clone());
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  let clockReads = 0;
  const client = new TmoneyGoAuthClient({
    salt: "synthetic-salt",
    fetch: transport,
    timeoutMs,
    now: () => {
      clockReads++;
      return new Date("2026-12-31T15:04:59Z");
    },
  });
  return { client, urls, requests, clockReads: () => clockReads };
}

async function failure(operation: Promise<unknown>, code: GoAuthError["code"]) {
  const error: unknown = await operation.then(
    () => null,
    (value: unknown) => value,
  );
  expect(error).toBeInstanceOf(GoAuthError);
  if (!(error instanceof GoAuthError)) throw new TypeError("Expected safe auth error");
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  expect(Object.keys(error).sort()).toEqual(["code", "name"]);
  expect(`${Bun.inspect(error)} ${JSON.stringify(error)}`).not.toContain(secret);
}

test("sends guest identity request and strips unneeded response fields", async () => {
  // Given
  const fake = fixture(() =>
    Response.json({
      rstCd: 200,
      dta: {
        rspCd: "0000",
        data: {
          ...completion,
          appScheme: "supertoss://toss-cert/v2/sign/user/auth/id?txId=synthetic",
          secret,
        },
      },
    }),
  );
  // When
  const result = await fake.client.startToss(device, identity);
  // Then
  expect(result.txId).toBe("synthetic-tx");
  expect(String(result.appScheme)).toBe(
    "supertoss://toss-cert/v2/sign/user/auth/id?txId=synthetic",
  );
  expect(result).toMatchObject(completion);
  expect(Object.keys(result).sort()).toEqual(["appScheme", "moappMbrsSno", "reqSno", "txId"]);
  expect(fake.urls).toEqual(["https://tiaapi.tmoney.co.kr:20328/api/mbrs/auth/v2/toss/auth"]);
  const request = fake.requests[0];
  if (!request) throw new TypeError("Expected request");
  expect(await request.json()).toEqual(identity);
  expect(
    Object.fromEntries(
      ["authorization", "appcode", "uuid", "appver", "osknd", "osver"].map((key) => [
        key,
        request.headers.get(key),
      ]),
    ),
  ).toEqual({
    authorization: null,
    appcode: "MIC",
    uuid: device.uuid,
    appver: "2.7.1",
    osknd: "A",
    osver: "34",
  });
});

const member = {
  prsnAuthScsYn: "Y",
  joinYn: "Y",
  ageDvsCd: "1",
  authTkn: secret,
  moappMbrsSno: "123456789",
};
test.each(["1", "2", "3", undefined])(
  "returns renewed credentials for an authenticated existing member with age code %s",
  async (ageDvsCd) => {
    // Given
    const fake = fixture((request) =>
      Response.json(
        new URL(request.url).pathname.endsWith("authResult")
          ? {
              rstCd: "200",
              dta: { rspCd: "0000", data: { ...member, ageDvsCd, userNm: "private", secret } },
            }
          : { rstCd: 200, dta: { authTkn: "synthetic-refreshed", secret } },
      ),
    );
    // When
    const result = await fake.client.completeToss(device, completion);
    // Then
    expect(result).toEqual({
      session: {
        ...device,
        token: "synthetic-refreshed",
        appCode: "MIC",
        appVer: "2.7.1",
        osKnd: "A",
      },
      moappMbrsSno: "123456789",
    });
    expect(fake.urls).toEqual([
      "https://tiaapi.tmoney.co.kr:20328/api/mbrs/auth/v2/toss/authResult",
      "https://tiaapi.tmoney.co.kr:20328/api/mbrs/v2/uptMbrsAuthTknInfo",
    ]);
    const [resultRequest, refresh] = fake.requests;
    if (!resultRequest || !refresh) throw new TypeError("Expected result and refresh");
    expect(await resultRequest.json()).toEqual({ ...completion, encYn: "Y" });
    expect(refresh.headers.get("authorization")).toBe(`Bearer ${secret}`);
    const body = await refresh.json();
    expect(body).toMatchObject({
      mbphHwId: device.uuid,
      rnwlDtm: "2027-01-01 00:04:59",
      mbphOsVer: "34",
      moappVer: "2.7.1",
      mblOsKndCd: "A",
    });
    expect(Object.keys(body).sort()).toEqual([
      "mblOsKndCd",
      "mbphHwId",
      "mbphOsVer",
      "moappMbrsSno",
      "moappVer",
      "rnwlDtm",
    ]);
    expect(fake.clockReads()).toBe(1);
  },
);

test.each([
  [{ ...member, prsnAuthScsYn: "N" }, "verification_unconfirmed"],
  [{ ...member, prsnAuthScsYn: "UNKNOWN" }, "response"],
  [{ ...member, joinYn: "N" }, "unsupported_member"],
  [{ ...member, authTkn: null }, "response"],
] as const)("does not refresh rejected member %j", async (data, code) => {
  // Given
  const fake = fixture(() => Response.json({ rstCd: 200, dta: { rspCd: "0000", data } }));
  // When / Then
  await failure(fake.client.completeToss(device, completion), code);
  expect(fake.requests).toHaveLength(1);
});

test.each([401, 403, 500, 302])("sanitizes HTTP %s without retry or redirect", async (status) => {
  // Given
  const fake = fixture(
    () => new Response(secret, { status, headers: { location: "http://127.0.0.1:1/leak" } }),
  );
  // When / Then
  await failure(
    fake.client.startToss(device, identity),
    status === 401 || status === 403
      ? "authentication_required"
      : status === 302
        ? "network"
        : "http",
  );
  expect(fake.requests).toHaveLength(1);
});

test.each([
  { rstCd: 500, dta: secret },
  { rstCd: 200, dta: { rspCd: "0000", data: { txId: null } } },
])("sanitizes malformed responses %j", async (body) => {
  // Given
  const fake = fixture(() => Response.json(body));
  // When / Then
  await failure(fake.client.startToss(device, identity), "response");
});

test("aborts a stalled response body", async () => {
  // Given
  const fake = fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"rstCd":'));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    30,
  );
  // When / Then
  await failure(fake.client.startToss(device, identity), "timeout");
});

test("rejects extra identity fields before transmission", async () => {
  // Given
  const fake = fixture(() => Response.json({}));
  // When / Then
  await failure(fake.client.startToss(device, { ...identity, ...{ token: secret } }), "input");
  expect(fake.requests).toHaveLength(0);
});

test("rejects provider authentication failure without retaining its message", async () => {
  // Given
  const fake = fixture(() => Response.json({ rstCd: 200, dta: { rspCd: "9999", rspMsg: secret } }));
  // When
  const operation = fake.client.startToss(device, identity);
  // Then
  await failure(operation, "authentication_required");
});

test.each([401, 403])(
  "keeps renewal rejection HTTP %s distinct from unconfirmed verification",
  async (status) => {
    // Given
    const fake = fixture((request) =>
      new URL(request.url).pathname.endsWith("authResult")
        ? Response.json({ rstCd: 200, dta: { rspCd: "0000", data: member } })
        : new Response(secret, { status }),
    );
    // When
    const operation = fake.client.completeToss(device, completion);
    // Then
    await failure(operation, "authentication_required");
    expect(fake.requests).toHaveLength(2);
    expect(fake.urls.map((url) => new URL(url).pathname)).toEqual([
      "/api/mbrs/auth/v2/toss/authResult",
      "/api/mbrs/v2/uptMbrsAuthTknInfo",
    ]);
  },
);

test("sanitizes malformed JSON", async () => {
  // Given
  const fake = fixture(() => new Response(secret));
  // When
  const operation = fake.client.startToss(device, identity);
  // Then
  await failure(operation, "response");
});

test("sanitizes transport exceptions carrying credentials", async () => {
  // Given
  const transport = Object.assign(
    async () => {
      throw new Error(secret, { cause: { token: secret } });
    },
    { preconnect: fetch.preconnect },
  );
  const client = new TmoneyGoAuthClient({ salt: "synthetic-salt", fetch: transport });
  // When
  const operation = client.startToss(device, identity);
  // Then
  await failure(operation, "network");
});

test("does not return temporary credentials when mandatory renewal fails", async () => {
  // Given
  const fake = fixture((request) =>
    Response.json(
      new URL(request.url).pathname.endsWith("authResult")
        ? { rstCd: 200, dta: { rspCd: "0000", data: member } }
        : { rstCd: 200, dta: { authTkn: null, secret } },
    ),
  );
  // When
  const operation = fake.client.completeToss(device, completion);
  // Then
  await failure(operation, "response");
  expect(fake.requests).toHaveLength(2);
});

test("aborts stalled response headers", async () => {
  // Given
  const fake = fixture(() => new Promise<Response>(() => {}), 30);
  // When
  const operation = fake.client.startToss(device, identity);
  // Then
  await failure(operation, "timeout");
});

test.each([
  undefined,
  "",
  "javascript:alert(1)",
  "https://toss-cert/v2/sign/user/auth/id",
  "supertoss://evil.example/path",
  "supertoss://user@toss-cert/path",
  "supertoss://toss-cert:123/path",
  "supertoss://toss-cert/",
  "supertoss://toss-cert/path#fragment",
  "supertoss://toss-cert/path\n",
  "supertoss://toss-cert/path?x=%0a",
  "supertoss://toss-cert/path\u0085",
])("rejects unsafe or missing appScheme case %# without leaking its value", async (appScheme) => {
  // Given
  const fake = fixture(() =>
    Response.json({
      rstCd: 200,
      dta: { rspCd: "0000", data: { ...completion, txId: secret, appScheme } },
    }),
  );
  // When / Then
  await failure(fake.client.startToss(device, identity), "response");
});

test.each(["0007", 7])("forwards request serial %j without changing its type", async (reqSno) => {
  // Given
  const fake = fixture((request) =>
    Response.json(
      new URL(request.url).pathname.endsWith("authResult")
        ? { rstCd: 200, dta: { rspCd: "0000", data: member } }
        : { rstCd: 200, dta: { authTkn: "synthetic-renewed" } },
    ),
  );
  // When
  await fake.client.completeToss(device, { ...completion, reqSno });
  // Then
  expect(await fake.requests[0]?.json()).toEqual({ ...completion, reqSno, encYn: "Y" });
});

test.each([
  { reqSno: undefined },
  { reqSno: null },
  { reqSno: "" },
  { reqSno: -1 },
  { reqSno: 1.5 },
  { reqSno: Number.MAX_SAFE_INTEGER + 1 },
  { moappMbrsSno: undefined },
  { moappMbrsSno: "" },
])("rejects incomplete start metadata case %# without exposing fields", async (changes) => {
  // Given
  const fake = fixture(() =>
    Response.json({
      rstCd: 200,
      dta: {
        rspCd: "0000",
        data: {
          ...completion,
          txId: secret,
          ...changes,
          appScheme: "supertoss://toss-cert/v2/sign/user/auth/id?txId=synthetic",
        },
      },
    }),
  );
  // When / Then
  await failure(fake.client.startToss(device, identity), "response");
  expect(fake.requests).toHaveLength(1);
});
