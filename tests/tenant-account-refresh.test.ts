import { expect, test } from "bun:test";
import { credentials } from "./booking-fixtures";
import {
  denied,
  gate,
  refreshFixture,
  renewedToken,
  success,
} from "./tenant-account-refresh-fixtures";

test("renews an expired account session once and returns its payment status", async () => {
  // Given an expired session and an accepting renewal endpoint.
  await using f = refreshFixture();
  // When the read-only status query encounters authentication failure.
  const status = await f.account.getStatus("intercity");
  // Then renewal restores the same account without another login.
  expect(status.connection).toBe("connected");
  expect(f.state.refreshRequests).toBe(1);
  expect(f.state.accountRequests).toBe(2);
  expect(f.store.status(f.user.userId)?.connectionId).toBe(f.user.connectionId);
});

test("keeps renewal authentication failure actionable without retrying the inquiry", async () => {
  // Given that both inquiry and renewal require authentication.
  await using f = refreshFixture();
  f.state.renew = async () => denied();
  // When a query tries to recover.
  await expect(f.account.getStatus("intercity")).rejects.toMatchObject({
    code: "authentication_required",
  });
  // Then exactly one renewal is attempted, without an inquiry retry.
  expect(f.state.refreshRequests).toBe(1);
  expect(f.state.accountRequests).toBe(1);
});

test("stops after one renewal when the replacement session is also rejected", async () => {
  // Given an inquiry endpoint that rejects every session.
  await using f = refreshFixture();
  f.state.account = async () => denied();
  // When recovery also encounters authentication failure.
  await expect(f.account.getStatus("intercity")).rejects.toMatchObject({
    code: "authentication_required",
  });
  // Then no recursive retry occurs.
  expect(f.state.refreshRequests).toBe(1);
  expect(f.state.accountRequests).toBe(2);
});

test.each([500, 200])(
  "does not renew on non-authentication inquiry failure (%s)",
  async (status) => {
    // Given HTTP failure or an unsupported response body.
    await using f = refreshFixture();
    f.state.account = async () => Response.json({}, { status });
    // When the inquiry fails.
    await expect(f.account.getStatus("intercity")).rejects.toMatchObject({
      code: status === 500 ? "http" : "response",
    });
    // Then credentials are never renewed.
    expect(f.state.refreshRequests).toBe(0);
    expect(f.state.accountRequests).toBe(1);
  },
);

test("shares renewal across simultaneous expired-session queries", async () => {
  // Given two expired queries held until both reach the provider.
  await using f = refreshFixture();
  const both = gate();
  const renewal = gate();
  f.state.account = async (stale, request) => {
    if (!stale) return success();
    if (request === 2) both.release();
    await both.wait();
    return denied();
  };
  f.state.renew = async () => {
    await renewal.wait();
    return Response.json({ rstCd: 200, dta: { authTkn: renewedToken } });
  };
  // When both inquiries recover concurrently.
  const statuses = Promise.all([
    f.account.getStatus("intercity"),
    f.account.getStatus("intercity"),
  ]);
  await renewal.entered;
  renewal.release();
  // Then both succeed with one shared renewal.
  expect((await statuses).map((item) => item.connection)).toEqual(["connected", "connected"]);
  expect(f.state.refreshRequests).toBe(1);
  expect(f.state.accountRequests).toBe(4);
});

test("reuses completed renewal when a concurrent old inquiry rejects later", async () => {
  // Given a second expired inquiry delayed until the first completes recovery.
  await using f = refreshFixture();
  const delayed = gate();
  f.state.account = async (stale, request) => {
    if (request === 2) await delayed.wait();
    return stale ? denied() : success();
  };
  // When the delayed failure arrives after renewal has finished.
  const first = f.account.getStatus("intercity");
  const second = f.account.getStatus("intercity");
  await delayed.entered;
  expect((await first).connection).toBe("connected");
  delayed.release();
  // Then it retries using the stored replacement, without renewing again.
  expect((await second).connection).toBe("connected");
  expect(f.state.refreshRequests).toBe(1);
  expect(f.state.accountRequests).toBe(4);
});

for (const phase of ["initial", "renewal", "retry"] as const) {
  for (const change of ["reconnect", "disconnect"] as const) {
    test(`does not return or query a new connection when ${change} occurs during ${phase}`, async () => {
      // Given a query paused at one of its provider awaits.
      await using f = refreshFixture();
      const pending = gate();
      f.state.account = async (stale, request) => {
        if ((phase === "initial" && request === 1) || (phase === "retry" && request === 2))
          await pending.wait();
        return stale ? denied() : success();
      };
      f.state.renew = async () => {
        if (phase === "renewal") await pending.wait();
        return Response.json({ rstCd: 200, dta: { authTkn: renewedToken } });
      };
      // When the account connection changes before the old request resolves.
      const outcome = f.account.getStatus("intercity").then(
        (value) => ({ kind: "result", value }),
        (error: unknown) => ({ kind: "error", error }),
      );
      await pending.entered;
      if (change === "reconnect")
        f.store.connect({ ...credentials, token: "synthetic-reconnected" });
      else f.store.disconnect(f.user.userId);
      pending.release();
      // Then the old request cannot consume or publish the new connection.
      const result = await outcome;
      if (change === "disconnect" && phase !== "renewal")
        expect(result).toEqual({ kind: "result", value: { connection: "not_connected" } });
      else expect(result).toMatchObject({ kind: "error", error: { code: "configuration" } });
      expect(f.state.refreshRequests).toBe(phase === "initial" ? 0 : 1);
      expect(f.state.accountRequests).toBe(phase === "retry" ? 2 : 1);
      expect(f.store.status(f.user.userId)?.connected).toBe(change === "reconnect");
    });
  }
}
