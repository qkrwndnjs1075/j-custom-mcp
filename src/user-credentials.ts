import { GoSessionSchema } from "./go-account";
import { TmoneyGoAuthClient } from "./go-auth";
import type { GoCredentials } from "./go-credentials";
import type { UserStore } from "./user-store";
import { type UserId, UserStoreError } from "./user-types";

export type UserCredentials = GoCredentials & { readonly connectionId: string };

export class UserCredentialStore {
  readonly #store: UserStore;
  readonly #userId: UserId;
  readonly #makeAuth: (salt: string) => TmoneyGoAuthClient;
  #refreshing: Promise<UserCredentials> | undefined;

  constructor(
    store: UserStore,
    userId: UserId,
    makeAuth: (salt: string) => TmoneyGoAuthClient = (salt) => new TmoneyGoAuthClient({ salt }),
  ) {
    this.#store = store;
    this.#userId = userId;
    this.#makeAuth = makeAuth;
  }

  async read(): Promise<UserCredentials> {
    const { credentials, connectionId } = this.#store.read(this.#userId);
    return { ...credentials, connectionId };
  }

  assertCurrent(expected: UserCredentials): void {
    const current = this.#store.read(this.#userId);
    if (
      current.connectionId !== expected.connectionId ||
      current.credentials.moappMbrsSno !== expected.moappMbrsSno ||
      current.credentials.busUserNumber !== expected.busUserNumber
    )
      throw new UserStoreError("connection_changed");
  }

  async refresh(expected?: UserCredentials): Promise<UserCredentials> {
    if (expected) {
      const current = this.#store.read(this.#userId);
      if (current.connectionId !== expected.connectionId)
        throw new UserStoreError("connection_changed");
      if (current.credentials.token !== expected.token)
        return { ...current.credentials, connectionId: current.connectionId };
    }
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = this.#renew();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = undefined;
    }
  }

  async #renew(): Promise<UserCredentials> {
    const { credentials, revision, connectionId } = this.#store.read(this.#userId);
    const renewed = await this.#makeAuth(credentials.refreshSalt).refresh(
      GoSessionSchema.parse(credentials),
      credentials.moappMbrsSno,
    );
    const result = { ...credentials, ...renewed };
    if (!this.#store.update(this.#userId, revision, result))
      throw new UserStoreError("connection_changed");
    return { ...result, connectionId };
  }
}
