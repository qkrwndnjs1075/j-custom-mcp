import { expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AuthTokenStore } from "../src/auth-token-store";
import { ConnectionAuth } from "../src/connection-auth";
import { createConnectionHandler } from "../src/connection-http";
import { OAuthService } from "../src/oauth-service";
import { oauthDigest, oauthSecret } from "../src/oauth-types";
import { UserStore } from "../src/user-store";

export const origin = "https://mcp.example";
const resource = `${origin}/mcp`;
const redirect = "https://client.example/callback";

export function connectionFixture() {
  const directory = mkdtempSync(join(tmpdir(), "connection-http-"));
  const users = new UserStore(join(directory, "users.sqlite"));
  const tokens = new AuthTokenStore(join(directory, "oauth.sqlite"));
  const state: {
    appScheme: string | undefined;
    paymentInquiries: number;
    approved: boolean;
    now: number;
    starts: number;
    finishes: number;
    completionPaths: string[];
    resultHttpStatus: number;
    refreshHttpStatus: number;
    resultCode: string;
    resultFlag: string | undefined;
    missingStartMetadata: "reqSno" | "moappMbrsSno" | undefined;
    startedChallenges: {
      readonly device: string;
      readonly txId: string;
      readonly reqSno: string;
      readonly moappMbrsSno: string;
    }[];
    resultRequests: { readonly device: string; readonly body: unknown }[];
    startGate: Promise<void> | undefined;
    finishGate: Promise<void> | undefined;
    onStart: () => void;
    onFinish: () => void;
  } = {
    appScheme:
      "supertoss://toss-cert/v2/sign/user/auth/id?txId=synthetic-launch&token=synthetic-launch-token",
    paymentInquiries: 0,
    approved: true,
    now: 1_800_000_000_000,
    starts: 0,
    finishes: 0,
    completionPaths: [],
    resultHttpStatus: 200,
    refreshHttpStatus: 200,
    resultCode: "0000",
    resultFlag: undefined,
    missingStartMetadata: undefined,
    startedChallenges: [],
    resultRequests: [],
    startGate: undefined,
    finishGate: undefined,
    onStart: () => {},
    onFinish: () => {},
  };
  const members = new Map<string, string>();
  const transport = Object.assign(
    async (input: string | URL | Request) => {
      if (!(input instanceof Request)) throw new TypeError("Expected GO request");
      const path = new URL(input.url).pathname;
      const device = input.headers.get("UUID") ?? "";
      if (path.endsWith("/toss/auth")) {
        state.starts++;
        const body = z.object({ userPhone: z.string() }).parse(await input.json());
        members.set(device, body.userPhone === "01011112222" ? "synthetic-alice" : "synthetic-bob");
        state.onStart();
        await state.startGate;
        const challenge = {
          device,
          txId: `tx-${device}`,
          reqSno: `synthetic-private-request-${device}`,
          moappMbrsSno: members.get(device) ?? "",
        };
        state.startedChallenges.push(challenge);
        return Response.json({
          rstCd: 200,
          dta: {
            rspCd: "0000",
            data: {
              txId: challenge.txId,
              appScheme: state.appScheme,
              ...(state.missingStartMetadata === "reqSno" ? {} : { reqSno: challenge.reqSno }),
              ...(state.missingStartMetadata === "moappMbrsSno"
                ? {}
                : { moappMbrsSno: challenge.moappMbrsSno }),
            },
          },
        });
      }
      if (path.endsWith("/toss/authResult")) {
        state.finishes++;
        state.resultRequests.push({ device, body: await input.json() });
        state.completionPaths.push(path);
        state.onFinish();
        await state.finishGate;
        if (state.resultHttpStatus !== 200)
          return new Response("synthetic-private-error", { status: state.resultHttpStatus });
        return Response.json({
          rstCd: 200,
          dta: {
            rspCd: state.resultCode,
            rspMsg: "synthetic-private-error",
            data: {
              prsnAuthScsYn: state.resultFlag ?? (state.approved ? "Y" : "N"),
              joinYn: "Y",
              ageDvsCd: "1",
              authTkn: "synthetic-auth-token",
              moappMbrsSno: members.get(device),
            },
          },
        });
      }
      if (path.endsWith("/uptMbrsAuthTknInfo")) {
        state.completionPaths.push(path);
        if (state.refreshHttpStatus !== 200)
          return new Response("synthetic-private-error", { status: state.refreshHttpStatus });
        return Response.json({ rstCd: 200, dta: { authTkn: "synthetic-refreshed-token" } });
      }
      if (path.endsWith("/inqrPymMnsListAtPym")) {
        state.paymentInquiries++;
        return Response.json({
          rstCd: 200,
          dta: {
            npayautPymInfo: {
              cardCpNm: "Synthetic",
              cardNum4th: "0000",
              automaticPayId: "synthetic-billing-reference",
            },
          },
        });
      }
      if (path.endsWith("/getUsrSno.do")) {
        state.completionPaths.push(path);
        return Response.json({ errCode: "00000", USR_SNO: `bus-${members.get(device)}` });
      }
      throw new TypeError("Unexpected GO endpoint");
    },
    { preconnect: fetch.preconnect },
  );
  const oauth = new OAuthService({
    issuerUrl: origin,
    resourceUrl: resource,
    store: tokens,
    now: () => Math.floor(state.now / 1000),
  });
  const handler = createConnectionHandler({
    baseUrl: new URL(origin),
    users,
    oauth,
    auth: new ConnectionAuth({
      salt: "synthetic-refresh-salt",
      osRelease: "14",
      country: "KR",
      fetch: transport,
    }),
    osVer: "34",
    now: () => state.now,
    disconnect: async (id) => users.disconnect(id),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) =>
      (await handler(request)) ??
      (await oauth.handle(request)) ??
      new Response(null, { status: 404 }),
  });
  const request = (path: string, options?: RequestInit) =>
    fetch(new URL(path, server.url), { ...options, redirect: "manual" });
  async function register() {
    const response = await request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Synthetic VOOY", redirect_uris: [redirect] }),
    });
    expect(response.status).toBe(201);
    return z.object({ client_id: z.string() }).parse(await response.json()).client_id;
  }
  async function authorize(clientId: string) {
    const verifier = oauthSecret();
    const query = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirect,
      response_type: "code",
      resource,
      scope: "mcp",
      state: "synthetic-state",
      code_challenge: oauthDigest(verifier),
      code_challenge_method: "S256",
    });
    const response = await request(`/oauth/authorize?${query}`);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    return { path: `${location.pathname}${location.search}`, verifier };
  }
  async function exchange(clientId: string, verifier: string, response: Response) {
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("location") ?? "");
    expect(callback.searchParams.get("state")).toBe("synthetic-state");
    const tokenResponse = await request("/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        resource,
        redirect_uri: redirect,
        code_verifier: verifier,
        code: callback.searchParams.get("code") ?? "",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    return z
      .object({ access_token: z.string(), refresh_token: z.string() })
      .parse(await tokenResponse.json());
  }
  return {
    users,
    oauth,
    state,
    request,
    register,
    authorize,
    exchange,
    close: () => {
      server.stop(true);
      tokens.close();
      users.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export class ConnectionBrowser {
  cookie = "";
  csrf = "";
  readonly pages: string[] = [];
  constructor(readonly fixture: ReturnType<typeof connectionFixture>) {}
  async open(path = "/connect"): Promise<Response> {
    const response = await this.fixture.request(path, { headers: { cookie: this.cookie } });
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    if (cookie) this.cookie = cookie;
    if (response.status === 303) return this.open("/connect");
    const html = await response.text();
    this.pages.push(html);
    this.csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    return response;
  }
  post(path: string, fields: Record<string, string> = {}) {
    return this.fixture.request(path, {
      method: "POST",
      headers: { cookie: this.cookie, origin },
      body: new URLSearchParams({ csrf: this.csrf, ...fields }),
    });
  }
  async consent() {
    expect(
      (await this.post("/connect/consent", { goTerms: "yes", accountAccess: "yes" })).status,
    ).toBe(303);
    await this.open();
  }
  async start(phone = "01011112222") {
    const response = await this.post("/connect/start", {
      userName: "Synthetic Person",
      userPhone: phone,
      userBirthday: "19930317",
    });
    if (response.status === 303) await this.open();
    return response;
  }
  async finish() {
    const response = await this.post("/connect/finish");
    if (response.status === 303) await this.open();
    return response;
  }
  async connect(phone?: string) {
    await this.consent();
    expect((await this.start(phone)).status).toBe(303);
    expect((await this.finish()).status).toBe(303);
  }
}
