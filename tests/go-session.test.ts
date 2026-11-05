import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoAccountError } from "../src/go-account";
import { GoAccountService, readGoSession } from "../src/go-session";

const syntheticSession = {
  token: "synthetic-account-token",
  appCode: "TEST",
  uuid: "synthetic-device-id",
  appVer: "2.7.1",
  osKnd: "A",
  osVer: "15",
};

async function withSessionFile(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "go-session-"));
  const path = join(directory, "session.json");
  try {
    await writeFile(path, JSON.stringify(syntheticSession), { mode: 0o600 });
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reads a private session and observes replacement on the next read", async () => {
  await withSessionFile(async (path) => {
    expect((await readGoSession(path)).token).toBe(syntheticSession.token);
    const replacement = { ...syntheticSession, token: "synthetic-rotated-token" };
    await writeFile(path, JSON.stringify(replacement), { mode: 0o600 });
    expect((await readGoSession(path)).token).toBe(replacement.token);
  });
});

test.each([0o640, 0o604, 0o644])("rejects a session readable by others: %o", async (mode) => {
  await withSessionFile(async (path) => {
    await chmod(path, mode);
    await expect(readGoSession(path)).rejects.toMatchObject({ code: "configuration" });
  });
});

test("rejects symlink session paths", async () => {
  await withSessionFile(async (path) => {
    const link = `${path}.link`;
    await symlink(path, link);
    await expect(readGoSession(link)).rejects.toMatchObject({ code: "configuration" });
  });
});

test("rejects FIFO session paths without waiting for a writer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "go-session-fifo-"));
  const path = join(directory, "session.pipe");
  try {
    const fifo = Bun.spawn(["mkfifo", "-m", "600", path]);
    expect(await fifo.exited).toBe(0);
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        'import { readGoSession } from "./src/go-session.ts"; await readGoSession(process.argv[1]).then(() => process.exit(1), error => process.exit(error.code === "configuration" ? 0 : 2));',
        path,
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "ignore", stderr: "ignore" },
    );
    const deadline = setTimeout(() => child.kill("SIGKILL"), 2_000);
    try {
      expect(await child.exited).toBe(0);
    } finally {
      clearTimeout(deadline);
      child.kill();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  "synthetic-private-malformed-json",
  JSON.stringify({ ...syntheticSession, token: "synthetic-private\r\nheader" }),
  JSON.stringify({ ...syntheticSession, token: "synthetic-private".repeat(2000) }),
])("rejects invalid private content without retaining it in errors", async (content) => {
  await withSessionFile(async (path) => {
    await writeFile(path, content, { mode: 0o600 });
    const error: unknown = await readGoSession(path).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoAccountError);
    if (!(error instanceof GoAccountError)) throw new Error("Expected sanitized account error");
    expect(error.code).toBe("configuration");
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("synthetic-private");
    expect(error.message).not.toContain(path);
    expect(error.stack).not.toContain("synthetic-private");
  });
});

test("reports missing configuration without claiming account authentication", async () => {
  const account = new GoAccountService();
  expect(await account.getStatus("intercity")).toEqual({ connection: "not_configured" });
  expect(JSON.stringify(account)).toBe("{}");
});
