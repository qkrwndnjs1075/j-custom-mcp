import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { GoAuthError, GoDeviceSchema } from "./go-auth-types";

const refreshInputSchema = z.strictObject({
  device: GoDeviceSchema,
  memberSerial: z.string().min(1).max(256),
  salt: z.string().min(1).max(4096),
  now: z.date(),
});

export function createGoRefreshBody(
  input: z.infer<typeof refreshInputSchema>,
  iv = randomBytes(12),
) {
  const parsed = refreshInputSchema.safeParse(input);
  if (!parsed.success || iv.length !== 12) throw new GoAuthError("configuration");
  const { device, memberSerial, salt, now } = parsed.data;
  const seoul = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const year = String(seoul.getUTCFullYear()).padStart(4, "0");
  const month = String(seoul.getUTCMonth() + 1).padStart(2, "0");
  const day = String(seoul.getUTCDate()).padStart(2, "0");
  const hour = String(seoul.getUTCHours()).padStart(2, "0");
  const minute = String(seoul.getUTCMinutes()).padStart(2, "0");
  const second = String(seoul.getUTCSeconds()).padStart(2, "0");
  let digest: Buffer = Buffer.from(`${salt}${hour}${day}${second}${month}${minute}${year}`, "utf8");
  for (let round = 0; round < 6; round++) digest = createHash("sha256").update(digest).digest();
  const key = Buffer.from(digest.toString("hex").toUpperCase().slice(0, 32), "ascii");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(memberSerial, "utf8"), cipher.final()]);
  return {
    mbphHwId: device.uuid,
    moappMbrsSno: Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64"),
    rnwlDtm: `${year}-${month}-${day} ${hour}:${minute}:${second}`,
    mbphOsVer: device.osVer,
    moappVer: "2.7.1",
    mblOsKndCd: "A",
  };
}
