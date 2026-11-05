import {
  type GoDevice,
  TmoneyGoAuthClient,
  type TossChallenge,
  type TossIdentity,
} from "./go-auth";
import { TmoneyGoBusClient } from "./go-bus";

export class ConnectionAuth {
  readonly #salt: string;
  readonly #auth: TmoneyGoAuthClient;
  readonly #bus: TmoneyGoBusClient;
  readonly #osRelease: string;
  readonly #country: string;

  constructor(options: {
    readonly salt: string;
    readonly osRelease: string;
    readonly country: string;
    readonly fetch?: typeof globalThis.fetch;
  }) {
    this.#salt = options.salt;
    this.#auth = new TmoneyGoAuthClient(options);
    this.#bus = new TmoneyGoBusClient(options);
    this.#osRelease = options.osRelease;
    this.#country = options.country;
  }

  start(device: GoDevice, identity: TossIdentity) {
    return this.#auth.startToss(device, identity);
  }

  async finish(device: GoDevice, challenge: TossChallenge) {
    const authenticated = await this.#auth.completeToss(device, challenge);
    const busUserNumber = await this.#bus.lookupUser(
      {
        session: authenticated.session,
        userNumber: "",
        osRelease: this.#osRelease,
        country: this.#country,
        ipAddress: "",
      },
      authenticated.moappMbrsSno,
    );
    return {
      credentials: {
        ...authenticated.session,
        moappMbrsSno: authenticated.moappMbrsSno,
        busUserNumber,
        refreshSalt: this.#salt,
        osRelease: this.#osRelease,
        country: this.#country,
      },
    };
  }
}
