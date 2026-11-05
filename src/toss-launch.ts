import { z } from "zod";

export const TossAppSchemeSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => {
    if (/\s|\p{Cc}/u.test(value) || /%0[0-9a-f]|%1[0-9a-f]|%7f/i.test(value)) return false;
    try {
      const url = new URL(value);
      return (
        value.startsWith("supertoss://toss-cert/") &&
        url.protocol === "supertoss:" &&
        url.hostname === "toss-cert" &&
        url.port === "" &&
        url.username === "" &&
        url.password === "" &&
        url.pathname.length > 1 &&
        url.hash === ""
      );
    } catch (error) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  })
  .brand<"TossAppScheme">();

export type TossAppScheme = z.infer<typeof TossAppSchemeSchema>;
