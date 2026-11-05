import { GoSessionSchema } from "./go-account";
import { TmoneyGoAuthClient } from "./go-auth";
import { type GoCredentials, GoCredentialsSchema } from "./go-credential-types";
import { readGoPrivateFile, writeGoPrivateFile } from "./go-private-file";

export { type GoCredentials, GoCredentialsSchema } from "./go-credential-types";

export class GoCredentialStore {
  readonly #path: string;
  readonly #makeAuth: (salt: string) => TmoneyGoAuthClient;
  #refreshing: Promise<GoCredentials> | undefined;

  constructor(
    path: string,
    makeAuth: (salt: string) => TmoneyGoAuthClient = (salt) => new TmoneyGoAuthClient({ salt }),
  ) {
    this.#path = path;
    this.#makeAuth = makeAuth;
  }

  read(): Promise<GoCredentials> {
    return readGoPrivateFile(this.#path, GoCredentialsSchema);
  }

  save(credentials: GoCredentials): Promise<void> {
    return writeGoPrivateFile(this.#path, credentials, GoCredentialsSchema);
  }

  async refresh(): Promise<GoCredentials> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#renew();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }

  async #renew(): Promise<GoCredentials> {
    const credentials = await this.read();
    const session = GoSessionSchema.parse(credentials);
    const renewed = await this.#makeAuth(credentials.refreshSalt).refresh(
      session,
      credentials.moappMbrsSno,
    );
    const result = { ...credentials, ...renewed };
    await this.save(result);
    return result;
  }
}
