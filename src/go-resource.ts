import { readFile, stat } from "node:fs/promises";
import { load } from "cheerio";
import { GoAccountError } from "./go-account";

export async function loadGoRefreshSalt(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 16_777_216) throw new GoAccountError("configuration");
    const xml = load(await readFile(path, "utf8"), { xml: true });
    const entry = xml('resources > string[name="crypt_key_salt"]');
    const salt = entry.text();
    if (entry.length !== 1 || salt.length === 0 || salt.length > 4096)
      throw new GoAccountError("configuration");
    return salt;
  } catch (error) {
    if (error instanceof GoAccountError) throw error;
    throw new GoAccountError("configuration");
  }
}
