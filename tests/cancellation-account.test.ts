import { expect, test } from "bun:test";
import { bookingBinding } from "../src/booking-types";
import { CancellationAccount } from "../src/cancellation-account";
import { GoBusHttp } from "../src/go-bus-http";
import { refreshFixture, renewedToken } from "./tenant-account-refresh-fixtures";

test.each([false, true])(
  "refreshes a cancellation read only once when repeated denial=%s",
  async (repeated) => {
    // Given
    await using item = refreshFixture();
    const account = new CancellationAccount(item.credentialStore);
    const binding = bookingBinding(await item.credentialStore.read());
    let calls = 0;
    const http = new GoBusHttp({
      fetch: Object.assign(
        async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const request = new Request(input, init);
          calls++;
          if (repeated || request.headers.get("authorization") !== `Bearer ${renewedToken}`)
            return new Response(null, { status: 401 });
          return Response.json({ errCode: "00000", payList: [] });
        },
        { preconnect: fetch.preconnect },
      ),
    });
    // When
    const result = account.query(binding, (session) =>
      http.post(session.context, { path: "user/selectMyPagePayList.do", body: {} }),
    );
    // Then
    if (repeated) await expect(result).rejects.toThrow("authentication");
    else expect(await result).toMatchObject({ payList: [] });
    expect(item.state.refreshRequests).toBe(1);
    expect(calls).toBe(2);
  },
);
test("rejects a stale account at the synchronous mutation fence", async () => {
  // Given
  await using item = refreshFixture();
  const account = new CancellationAccount(item.credentialStore);
  const old = await account.read();
  item.store.connect(old);
  // When / Then
  expect(() => account.context(old)).toThrow("Account connection changed");
});
