import { z } from "zod";
import { GoSessionSchema } from "./go-account";

export const GoCredentialsSchema = GoSessionSchema.unwrap()
  .extend({
    moappMbrsSno: z.string().min(1).max(256),
    busUserNumber: z.string().min(1).max(256),
    refreshSalt: z.string().min(1).max(4096),
    osRelease: z.string().regex(/^\d{1,3}(?:\.\d+)*$/),
    country: z.string().regex(/^[A-Z]{2}$/),
  })
  .readonly();
export type GoCredentials = z.infer<typeof GoCredentialsSchema>;
