import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { BookingError } from "./booking-types";
import { OAuthServiceError } from "./oauth-types";
import type { SqlValue, SyncDatabase, SyncStatement } from "./sql-database";
import { UserStoreError } from "./user-types";

export { loadGoRefreshSalt } from "./go-resource";
export const localFileExists = existsSync;
function preparePrivateDatabase(path: string): string {
  if (path === ":memory:") return path;
  const destination = resolve(path);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = lstatSync(parent);
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid?.()
  ) {
    throw new BookingError("configuration");
  }
  const file = openSync(
    destination,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new BookingError("configuration");
    }
  } finally {
    closeSync(file);
  }
  return destination;
}

function privateDirectory(path: string): string {
  const destination = resolve(path);
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const directory = lstatSync(parent);
  if (
    !directory.isDirectory() ||
    (directory.mode & 0o077) !== 0 ||
    directory.uid !== process.getuid?.()
  ) {
    throw new UserStoreError("configuration");
  }
  return destination;
}

export function privateVaultFile(path: string): string {
  const destination = privateDirectory(path);
  const fd = openSync(
    destination,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    ) {
      throw new UserStoreError("configuration");
    }
  } finally {
    closeSync(fd);
  }
  return destination;
}

export function loadVaultKey(keyPath: string, existingDatabase: boolean): Uint8Array {
  const exists = existsSync(keyPath);
  if (!exists && existingDatabase) throw new UserStoreError("configuration");
  const path = exists ? privateVaultFile(keyPath) : privateDirectory(keyPath);
  const fd = openSync(
    path,
    constants.O_RDWR | constants.O_NOFOLLOW | (exists ? 0 : constants.O_CREAT | constants.O_EXCL),
    0o600,
  );
  try {
    if (!exists) {
      writeFileSync(fd, randomBytes(32));
      fsyncSync(fd);
    }
    if (fstatSync(fd).size !== 32) throw new UserStoreError("configuration");
    const key = Buffer.alloc(32);
    if (readSync(fd, key, 0, 32, 0) !== 32) throw new UserStoreError("configuration");
    return key;
  } finally {
    closeSync(fd);
  }
}
function openLocalOAuthDatabase(path: string): Database {
  try {
    const destination = resolve(path);
    const directory = dirname(destination);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.())
      throw new OAuthServiceError("temporarily_unavailable");
    try {
      closeSync(
        openSync(
          destination,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        ),
      );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(destination);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      throw new OAuthServiceError("temporarily_unavailable");
    const db = new Database(destination, { strict: true });
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;",
    );
    return db;
  } catch (error) {
    if (error instanceof OAuthServiceError) throw error;
    throw new OAuthServiceError("temporarily_unavailable");
  }
}

function portableDatabase(db: Database): SyncDatabase {
  return {
    query<Row extends Record<string, SqlValue>, Params extends SqlValue[]>(
      sql: string,
    ): SyncStatement<Row, Params> {
      const statement = db.query<Row, SqlValue[]>(sql);
      return {
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
        run: (...params) => statement.run(...params),
      };
    },
    exec: (sql) => {
      db.exec(sql);
    },
    run: (sql) => {
      db.run(sql);
    },
    transaction: (fn) => db.transaction(fn),
    close: () => {
      db.close();
    },
  };
}

function configureLocalDatabase(db: Database, pragmas: string): SyncDatabase {
  try {
    db.run(pragmas);
    return portableDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

export function openLocalDatabase(
  path: string,
  kind: "booking" | "oauth" | "watch" | "users",
): SyncDatabase {
  switch (kind) {
    case "oauth":
      return portableDatabase(openLocalOAuthDatabase(path));
    case "booking": {
      const db = new Database(preparePrivateDatabase(path), { strict: true });
      return configureLocalDatabase(
        db,
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
      );
    }
    case "watch": {
      const db = new Database(path, { strict: true });
      db.run("PRAGMA journal_mode=WAL;");
      return portableDatabase(db);
    }
    case "users": {
      const db = new Database(privateVaultFile(path), { strict: true });
      return configureLocalDatabase(
        db,
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
      );
    }
    default: {
      const exhaustive: never = kind;
      throw exhaustive;
    }
  }
}
export function localBookingIp(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    const address = addresses?.find((entry) => entry.family === "IPv4" && !entry.internal);
    if (address) return address.address;
  }
  return "";
}
