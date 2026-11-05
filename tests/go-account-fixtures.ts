import { afterEach, expect } from "bun:test";
import { GoAccountError, GoSessionSchema, TmoneyGoAccountClient } from "../src/go-account";

export const secret = "synthetic-secret-must-not-escape";
export const session = GoSessionSchema.parse({
  token: secret,
  appCode: "SYNTHETIC",
  uuid: "synthetic-device",
  appVer: "1.0",
  osKnd: "A",
  osVer: "14",
});
export const registered = {
  cardCpNm: secret,
  cardNum4th: "9999",
  automaticPayId: secret,
  displayYn: "N",
  mbrsUseYn: "Y",
};
const listeners: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop(true);
});

export function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  timeoutMs = 10_000,
) {
  const requests: Request[] = [];
  const providerUrls: string[] = [];
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.clone());
      return handler(request);
    },
  });
  listeners.push(listener);
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      providerUrls.push(request.url);
      return fetch(new Request(new URL(new URL(request.url).pathname, listener.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  return {
    client: new TmoneyGoAccountClient({ fetch: transport, timeoutMs }),
    requests,
    providerUrls,
  };
}

export async function expectFailure(operation: Promise<unknown>, code: GoAccountError["code"]) {
  const error: unknown = await operation.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(GoAccountError);
  if (!(error instanceof GoAccountError)) throw new TypeError("Expected a sanitized account error");
  expect(error.code).toBe(code);
  expect(error.cause).toBeUndefined();
  expect(Object.keys(error).sort()).toEqual(["code", "name"]);
  expect(`${Bun.inspect(error)} ${JSON.stringify(error)}`).not.toContain(secret);
}
