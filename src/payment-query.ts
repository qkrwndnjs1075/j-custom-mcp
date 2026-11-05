import { z } from "zod";
import { BusServiceSchema } from "./bus-service";

export const PaymentQuerySchema = z
  .union([z.strictObject({ tripRef: z.uuid() }), z.strictObject({ service: BusServiceSchema })])
  .meta({ type: "object" });
