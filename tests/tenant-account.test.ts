import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmoneyGoAccountClient } from "../src/go-account";
import { TenantAccountService } from "../src/tenant-account";
import { UserCredentialStore } from "../src/user-credentials";
import { UserStore } from "../src/user-store";
import { credentials } from "./booking-fixtures";

const resources: { readonly directory: string; readonly store: UserStore }[] = [];
afterEach(() => {
  for (const item of resources.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "tenant-account-"));
  const store = new UserStore(join(directory, "users.sqlite"));
  resources.push({ directory, store });
  return store;
}

test("uses only the authenticated user's credential for payment account status", async () => {
  const store = setup();
  const alice = store.connect(credentials);
  const bob = store.connect({ ...credentials, moappMbrsSno: "bob", token: "bob-synthetic-token" });
  const headers: (string | null)[] = [];
  const transport = Object.assign(
    async (input: string | URL | Request) => {
      if (!(input instanceof Request)) throw new TypeError("Expected request");
      headers.push(input.headers.get("Authorization"));
      return Response.json({
        rstCd: 200,
        dta: { npayautPymInfo: null, npayPymInfo: { displayYn: "Y" } },
      });
    },
    { preconnect: fetch.preconnect },
  );
  const client = new TmoneyGoAccountClient({ fetch: transport });
  const a = new TenantAccountService(new UserCredentialStore(store, alice.userId), client);
  const b = new TenantAccountService(new UserCredentialStore(store, bob.userId), client);
  expect((await a.getStatus("intercity")).connection).toBe("connected");
  expect((await b.getStatus("intercity")).connection).toBe("connected");
  expect(headers).toEqual([`Bearer ${credentials.token}`, "Bearer bob-synthetic-token"]);
  store.disconnect(bob.userId);
  expect(await b.getStatus("intercity")).toEqual({ connection: "not_connected" });
  expect(headers).toHaveLength(2);
});

test("rejects an old account status response after reconnect", async () => {
  const store = setup();
  const alice = store.connect(credentials);
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const transport = Object.assign(
    async () => {
      started.resolve();
      return response.promise;
    },
    { preconnect: fetch.preconnect },
  );
  const account = new TenantAccountService(
    new UserCredentialStore(store, alice.userId),
    new TmoneyGoAccountClient({ fetch: transport }),
  );
  const status = account.getStatus("intercity");
  await started.promise;
  store.connect(credentials);
  response.resolve(Response.json({ rstCd: 200, dta: { npayautPymInfo: null } }));
  await expect(status).rejects.toMatchObject({ code: "configuration" });
});
