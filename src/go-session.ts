import type { BusService } from "./bus-service";
import { type GoSession, GoSessionSchema, TmoneyGoAccountClient } from "./go-account";
import { readGoPrivateFile } from "./go-private-file";

export async function readGoSession(path: string): Promise<GoSession> {
  return readGoPrivateFile(path, GoSessionSchema);
}

export class GoAccountService {
  readonly #sessionPath: string | undefined;
  readonly #client: TmoneyGoAccountClient;

  constructor(sessionPath?: string, client = new TmoneyGoAccountClient()) {
    this.#sessionPath = sessionPath;
    this.#client = client;
  }

  async getStatus(service: BusService) {
    if (this.#sessionPath === undefined) return { connection: "not_configured" } as const;
    return this.#client.readPaymentStatus(await readGoSession(this.#sessionPath), service);
  }
}
