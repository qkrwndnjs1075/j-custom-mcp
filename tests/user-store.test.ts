import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmoneyGoAuthClient } from "../src/go-auth";
import { UserCredentialStore } from "../src/user-credentials";
import { UserStore } from "../src/user-store";
import { UserIdSchema } from "../src/user-types";

const directories: string[] = [];
const stores: UserStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const credentials = {
  token: "synthetic-private-token",
  uuid: "synthetic-device",
  appCode: "MIC",
  appVer: "2.7.1",
  osKnd: "A",
  osVer: "37",
  osRelease: "17",
  country: "KR",
  moappMbrsSno: "synthetic-member",
  busUserNumber: "synthetic-bus-member",
  refreshSalt: "synthetic-private-salt",
};
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "user-vault-"));
  directories.push(dir);
  const path = join(dir, "users.sqlite");
  const store = new UserStore(path);
  stores.push(store);
  return { dir, path, store };
}

test("isolates credentials and stable verified identity when different members connect", () => {
  const { store } = fixture();
  const alice = store.connect(credentials);
  const bob = store.connect({ ...credentials, token: "bob-token", moappMbrsSno: "bob-member" });
  const aliceAgain = store.connect({ ...credentials, token: "alice-reconnected" });
  expect(aliceAgain.userId).toBe(alice.userId);
  expect(aliceAgain.connectionId).not.toBe(alice.connectionId);
  expect(bob.userId).not.toBe(alice.userId);
  expect(store.read(bob.userId).credentials.token).toBe("bob-token");
  expect(store.read(alice.userId).credentials.token).toBe("alice-reconnected");
  expect(() => store.read(UserIdSchema.parse(crypto.randomUUID()))).toThrow(
    "Connect your Tmoney GO",
  );
  expect(store.list()).toHaveLength(2);
  expect(JSON.stringify(store)).toBe("{}");
});

test("persists encrypted credentials in private files when reopened", () => {
  const { store, path } = fixture();
  const alice = store.connect(credentials);
  const reopened = new UserStore(path);
  stores.push(reopened);
  expect(reopened.read(alice.userId).credentials).toEqual(credentials);
  expect(reopened.connect(credentials).userId).toBe(alice.userId);
  for (const file of [path, `${path}.key`]) expect(statSync(file).mode & 0o777).toBe(0o600);
  const bytes = readFileSync(path).toString("utf8");
  for (const value of [credentials.token, credentials.refreshSalt, credentials.moappMbrsSno])
    expect(bytes).not.toContain(value);
});

test.each(["swap", "tamper", "revision"] as const)(
  "rejects authenticated ciphertext when %s occurs",
  (attack) => {
    const { store, path } = fixture();
    const alice = store.connect(credentials);
    const bob = store.connect({ ...credentials, moappMbrsSno: "bob" });
    const db = new Database(path);
    switch (attack) {
      case "swap":
        db.query(
          "UPDATE users SET ciphertext=(SELECT ciphertext FROM users WHERE user_id=?) WHERE user_id=?",
        ).run(alice.userId, bob.userId);
        break;
      case "tamper":
        db.query("UPDATE users SET ciphertext='AAAA' WHERE user_id=?").run(bob.userId);
        break;
      case "revision":
        db.query("UPDATE users SET revision=revision+1 WHERE user_id=?").run(bob.userId);
        break;
    }
    db.close();
    expect(() => store.read(bob.userId)).toThrow("could not be verified");
  },
);

test.each(["key", "directory", "database"] as const)("rejects exposed %s permissions", (target) => {
  const { path, dir } = fixture();
  chmodSync(target === "key" ? `${path}.key` : target === "directory" ? dir : path, 0o777);
  expect(() => new UserStore(path)).toThrow("configuration");
});

test("rejects missing or changed keys without remapping the account", () => {
  const { store, path } = fixture();
  store.connect(credentials);
  writeFileSync(`${path}.key`, Buffer.alloc(32, 1));
  expect(() => new UserStore(path)).toThrow("configuration");
  rmSync(`${path}.key`);
  expect(() => new UserStore(path)).toThrow("configuration");
});

test("rejects a symlink database path", () => {
  const { path, dir } = fixture();
  const link = join(dir, "link.sqlite");
  symlinkSync(path, link);
  expect(() => new UserStore(link, { keyPath: `${path}.key` })).toThrow("configuration");
});

test("rejects refresh identity changes and oversized credentials", () => {
  const { store } = fixture();
  const alice = store.connect(credentials);
  expect(
    store.update(alice.userId, alice.revision, { ...credentials, moappMbrsSno: "other" }),
  ).toBe(false);
  expect(store.update(alice.userId, alice.revision, { ...credentials, uuid: "other" })).toBe(false);
  expect(() => store.connect({ ...credentials, token: "a".repeat(20_000) })).toThrow(
    "configuration",
  );
  expect(store.read(alice.userId).credentials).toEqual(credentials);
});

test.each(["disconnect", "reconnect"] as const)(
  "cannot restore stale credentials when delayed refresh races %s",
  async (action) => {
    const { store } = fixture();
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
    const adapter = new UserCredentialStore(
      store,
      alice.userId,
      (salt) => new TmoneyGoAuthClient({ salt, fetch: transport }),
    );
    const refreshing = adapter.refresh();
    await started.promise;
    if (action === "disconnect") store.disconnect(alice.userId);
    else store.connect({ ...credentials, token: "new-connection" });
    response.resolve(Response.json({ rstCd: 200, dta: { authTkn: "old-refresh" } }));
    await expect(refreshing).rejects.toMatchObject({ code: "connection_changed" });
    if (action === "disconnect")
      expect(() => store.read(alice.userId)).toThrow("Connect your Tmoney GO");
    else expect(store.read(alice.userId).credentials.token).toBe("new-connection");
  },
);

test("preserves connection generation and coalesces concurrent token refresh", async () => {
  const { store } = fixture();
  const alice = store.connect(credentials);
  let calls = 0;
  const transport = Object.assign(
    async () => {
      calls++;
      return Response.json({ rstCd: 200, dta: { authTkn: "renewed-token" } });
    },
    { preconnect: fetch.preconnect },
  );
  const adapter = new UserCredentialStore(
    store,
    alice.userId,
    (salt) => new TmoneyGoAuthClient({ salt, fetch: transport }),
  );
  const results = await Promise.all([adapter.refresh(), adapter.refresh()]);
  expect(calls).toBe(1);
  for (const value of results) expect(value.connectionId).toBe(alice.connectionId);
  expect((await adapter.read()).token).toBe("renewed-token");
});

test("keeps disconnect durable and reconnect rotates generation", () => {
  const { store, path } = fixture();
  const alice = store.connect(credentials);
  store.disconnect(alice.userId);
  const reopened = new UserStore(path);
  stores.push(reopened);
  expect(reopened.status(alice.userId)?.connected).toBe(false);
  expect(() => reopened.read(alice.userId)).toThrow("Connect your Tmoney GO");
  const next = reopened.connect(credentials);
  expect(next.userId).toBe(alice.userId);
  expect(next.connectionId).not.toBe(alice.connectionId);
  expect(store.update(alice.userId, alice.revision, credentials)).toBe(false);
});

test("rejects stale writes across independent database handles", () => {
  const { store, path } = fixture();
  const alice = store.connect(credentials);
  const other = new UserStore(path);
  stores.push(other);
  expect(other.update(alice.userId, alice.revision, { ...credentials, token: "fresh" })).toBe(true);
  expect(store.update(alice.userId, alice.revision, { ...credentials, token: "stale" })).toBe(
    false,
  );
  expect(store.read(alice.userId).credentials.token).toBe("fresh");
});

test("redacts upstream authentication failure and retains the current credentials", async () => {
  const { store } = fixture();
  const alice = store.connect(credentials);
  const transport = Object.assign(async () => new Response(credentials.token, { status: 401 }), {
    preconnect: fetch.preconnect,
  });
  const adapter = new UserCredentialStore(
    store,
    alice.userId,
    (salt) => new TmoneyGoAuthClient({ salt, fetch: transport }),
  );
  const error: unknown = await adapter.refresh().catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "authentication_required" });
  expect(Bun.inspect(error)).not.toContain(credentials.token);
  expect(store.read(alice.userId).credentials).toEqual(credentials);
});
