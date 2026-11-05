import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmoneyGoAccountClient } from "../src/go-account";
import { TmoneyGoAuthClient } from "../src/go-auth";
import { TenantAccountService } from "../src/tenant-account";
import { UserCredentialStore } from "../src/user-credentials";
import { UserStore } from "../src/user-store";
import { credentials } from "./booking-fixtures";

export const success = () => Response.json({ rstCd: 200, dta: { npayautPymInfo: null } });
export const denied = () => new Response(null, { status: 401 });
export const renewedToken = "synthetic-account-renewed";

export function gate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: released.resolve,
    async wait() {
      entered.resolve();
      await released.promise;
    },
  };
}

export function refreshFixture() {
  const directory = mkdtempSync(join(tmpdir(), "tenant-account-refresh-"));
  const store = new UserStore(join(directory, "users.sqlite"));
  const user = store.connect(credentials);
  const state = {
    accountRequests: 0,
    refreshRequests: 0,
    async account(stale: boolean, _request: number): Promise<Response> {
      return stale ? denied() : success();
    },
    async renew(): Promise<Response> {
      return Response.json({ rstCd: 200, dta: { authTkn: renewedToken } });
    },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/uptMbrsAuthTknInfo")) {
        state.refreshRequests++;
        return state.renew();
      }
      if (path.endsWith("/inqrPymMnsListAtPym")) {
        state.accountRequests++;
        return state.account(
          request.headers.get("Authorization") !== `Bearer ${renewedToken}`,
          state.accountRequests,
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const transport: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  const makeAuth = (salt: string) => new TmoneyGoAuthClient({ salt, fetch: transport });
  const credentialStore = new UserCredentialStore(store, user.userId, makeAuth);
  const client = new TmoneyGoAccountClient({ fetch: transport });
  return {
    store,
    user,
    state,
    credentialStore,
    client,
    makeAuth,
    account: new TenantAccountService(credentialStore, client),
    async [Symbol.asyncDispose]() {
      await server.stop(true);
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
