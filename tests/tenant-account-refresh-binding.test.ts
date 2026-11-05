import { expect, test } from "bun:test";
import { credentials } from "./booking-fixtures";
import { gate, refreshFixture, renewedToken } from "./tenant-account-refresh-fixtures";

test("rejects renewal when reconnection happens between credential read and renewal", async () => {
  // Given a caller that read the old generation before its await yielded.
  await using f = refreshFixture();
  const original = await f.credentialStore.read();
  f.store.connect({ ...credentials, token: "synthetic-new-generation" });
  // When that caller resumes and requests renewal of its captured generation.
  await expect(f.credentialStore.refresh(original)).rejects.toMatchObject({
    code: "connection_changed",
  });
  // Then no provider call uses the newly connected credentials.
  expect(f.state.refreshRequests).toBe(0);
});

test("reuses a completed renewal when the caller still holds the expired session", async () => {
  // Given a concurrent caller whose captured session was already renewed.
  await using f = refreshFixture();
  const original = await f.credentialStore.read();
  await f.credentialStore.refresh();
  // When the delayed caller asks to renew its old session.
  const reused = await f.credentialStore.refresh(original);
  // Then the replacement is reused without another renewal.
  expect(reused.token).toBe(renewedToken);
  expect(reused.connectionId).toBe(original.connectionId);
  expect(f.state.refreshRequests).toBe(1);
});

test("rejects stale renewal and preserves the reconnected session when the provider completes", async () => {
  // Given an old renewal paused at the provider, followed by a new connection.
  await using f = refreshFixture();
  const pending = gate();
  f.state.renew = async () => {
    await pending.wait();
    return Response.json({ rstCd: 200, dta: { authTkn: renewedToken } });
  };
  const original = await f.credentialStore.read();
  const renewal = f.credentialStore.refresh(original).catch((error: unknown) => error);
  await pending.entered;
  f.store.connect({ ...credentials, token: "synthetic-new-generation" });
  // When an old caller asks for renewal while the old renewal remains in flight.
  const rejected = f.credentialStore.refresh(original).catch((error: unknown) => error);
  pending.release();
  // Then both reject and the CAS preserves the newly connected generation.
  expect(await rejected).toMatchObject({ code: "connection_changed" });
  expect(await renewal).toMatchObject({ code: "connection_changed" });
  expect((await f.credentialStore.read()).token).toBe("synthetic-new-generation");
  expect(f.state.refreshRequests).toBe(1);
});
