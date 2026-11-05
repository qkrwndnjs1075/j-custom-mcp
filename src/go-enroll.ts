import type { BusService } from "./bus-service";
import { TmoneyGoAccountClient } from "./go-account";
import { GoAuthError, type GoDevice, TmoneyGoAuthClient, type TossIdentity } from "./go-auth";
import { TmoneyGoBusClient } from "./go-bus";
import { GoCredentialStore } from "./go-credentials";
import { loadGoRefreshSalt } from "./go-resource";

export { GO_IDENTITY_TERMS_URL } from "./go-terms";

export type GoEnrollmentConfig = {
  readonly service: BusService;
  readonly resourcesPath: string;
  readonly sessionPath: string;
  readonly device: GoDevice;
  readonly osRelease: string;
  readonly country: string;
};

export type GoEnrollmentUI = {
  readonly enterIdentity: () => Promise<TossIdentity>;
  readonly approveToss: () => Promise<void>;
};

export async function enrollGoAccount(
  config: GoEnrollmentConfig,
  ui: GoEnrollmentUI,
  transport: typeof globalThis.fetch = globalThis.fetch,
) {
  const refreshSalt = await loadGoRefreshSalt(config.resourcesPath);
  const auth = new TmoneyGoAuthClient({ salt: refreshSalt, fetch: transport });
  const identity = await ui.enterIdentity();
  const challenge = await auth.startToss(config.device, identity);
  await ui.approveToss();
  const { txId, reqSno, moappMbrsSno } = challenge;
  const result = await auth.completeToss(config.device, { txId, reqSno, moappMbrsSno });
  const account = new TmoneyGoAccountClient({ fetch: transport });
  const status = await account.readPaymentStatus(result.session, config.service);
  const bus = new TmoneyGoBusClient({ fetch: transport });
  const context = {
    session: result.session,
    userNumber: "",
    osRelease: config.osRelease,
    country: config.country,
    ipAddress: "",
  };
  const busUserNumber = await bus.lookupUser(context, result.moappMbrsSno);
  if (!busUserNumber) throw new GoAuthError("response");
  await new GoCredentialStore(config.sessionPath).save({
    ...result.session,
    moappMbrsSno: result.moappMbrsSno,
    busUserNumber,
    refreshSalt,
    osRelease: config.osRelease,
    country: config.country,
  });
  return status;
}
