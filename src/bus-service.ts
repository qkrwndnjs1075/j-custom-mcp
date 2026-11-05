import { z } from "zod";

export const BusServiceSchema = z.enum(["intercity", "express"]);
export type BusService = z.infer<typeof BusServiceSchema>;
export const TerminalIdSchema = z.string().regex(/^(?:\d{3}|\d{7})$/);

export function terminalMatchesService(service: BusService, id: string): boolean {
  switch (service) {
    case "intercity":
      return /^\d{7}$/.test(id);
    case "express":
      return /^\d{3}$/.test(id);
  }
}
