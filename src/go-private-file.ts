import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { z } from "zod";
import { GoAccountError } from "./go-account";

const limitBytes = 16_384;

export async function readGoPrivateFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        stat.uid !== process.getuid?.() ||
        stat.size > limitBytes
      ) {
        throw new GoAccountError("configuration");
      }
      const buffer = Buffer.alloc(limitBytes + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset > limitBytes) throw new GoAccountError("configuration");
      const data: unknown = JSON.parse(buffer.subarray(0, offset).toString("utf8"));
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new GoAccountError("configuration");
      return parsed.data;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof GoAccountError) throw error;
    throw new GoAccountError("configuration");
  }
}

export async function writeGoPrivateFile<T>(path: string, value: T, schema: z.ZodType<T>) {
  const destination = resolve(path);
  const directory = dirname(destination);
  const temporary = join(directory, `.${basename(destination)}.${crypto.randomUUID()}.tmp`);
  try {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new GoAccountError("configuration");
    const text = JSON.stringify(parsed.data);
    if (Buffer.byteLength(text) > limitBytes) throw new GoAccountError("configuration");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(directory);
    if (!parent.isDirectory() || (parent.mode & 0o077) !== 0 || parent.uid !== process.getuid?.()) {
      throw new GoAccountError("configuration");
    }
    try {
      const file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      const parentHandle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await parentHandle.sync();
      } finally {
        await parentHandle.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  } catch (error) {
    if (error instanceof GoAccountError) throw error;
    throw new GoAccountError("configuration");
  }
}
