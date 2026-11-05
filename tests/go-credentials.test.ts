import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmoneyGoAuthClient } from "../src/go-auth";
import { GoCredentialStore } from "../src/go-credentials";
import { readGoSession } from "../src/go-session";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
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

async function destination() {
  const directory = await mkdtemp(join(tmpdir(), "go-credentials-"));
  directories.push(directory);
  return { directory, path: join(directory, "session.json") };
}

test("atomically saves private credentials and keeps the account reader compatible", async () => {
  const { directory, path } = await destination();
  const store = new GoCredentialStore(path);
  await store.save(credentials);
  expect((await lstat(path)).mode & 0o777).toBe(0o600);
  expect(await readdir(directory)).toEqual(["session.json"]);
  expect(await store.read()).toEqual(credentials);
  expect(await readGoSession(path)).toEqual({
    token: credentials.token,
    uuid: credentials.uuid,
    appCode: "MIC",
    appVer: "2.7.1",
    osKnd: "A",
    osVer: "37",
  });
  expect(JSON.stringify(store)).toBe("{}");
});

test("rejects an exposed destination directory without writing credentials", async () => {
  const { directory, path } = await destination();
  await chmod(directory, 0o755);
  await expect(new GoCredentialStore(path).save(credentials)).rejects.toMatchObject({
    code: "configuration",
  });
  expect(await readdir(directory)).toEqual([]);
});

test("rejects symlink destination directories", async () => {
  const { directory, path } = await destination();
  const link = `${directory}-link`;
  directories.push(link);
  await symlink(directory, link);
  await expect(
    new GoCredentialStore(join(link, "session.json")).save(credentials),
  ).rejects.toMatchObject({ code: "configuration" });
  expect(await Bun.file(path).exists()).toBe(false);
});

test("coalesces concurrent refresh and persists only the renewed token", async () => {
  const { path } = await destination();
  let calls = 0;
  const transport = Object.assign(
    async () => {
      calls++;
      return Response.json({ rstCd: 200, dta: { authTkn: "synthetic-renewed-token" } });
    },
    { preconnect: fetch.preconnect },
  );
  const store = new GoCredentialStore(
    path,
    (salt) => new TmoneyGoAuthClient({ salt, fetch: transport }),
  );
  await store.save(credentials);
  const results = await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
  expect(calls).toBe(1);
  expect(results.map((value) => value.token)).toEqual(Array(3).fill("synthetic-renewed-token"));
  expect((await store.read()).token).toBe("synthetic-renewed-token");
});

test("a failed refresh preserves the prior credential file and emits no secret", async () => {
  const { path } = await destination();
  const transport = Object.assign(async () => new Response(credentials.token, { status: 401 }), {
    preconnect: fetch.preconnect,
  });
  const store = new GoCredentialStore(
    path,
    (salt) => new TmoneyGoAuthClient({ salt, fetch: transport }),
  );
  await store.save(credentials);
  const result: unknown = await store.refresh().catch((error: unknown) => error);
  expect(result).toMatchObject({ code: "authentication_required" });
  expect(Bun.inspect(result)).not.toContain(credentials.token);
  expect(await store.read()).toEqual(credentials);
});
