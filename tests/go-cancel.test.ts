import { expect, test } from "bun:test";
import { GoBusError } from "../src/go-bus-types";
import {
  account,
  candidate,
  fixture,
  issued,
  native,
  rotatingIntercityFixture,
  ticket,
} from "./go-ticket-fixtures";

test.each([false, true])(
  "reconciles intercity cancellation with rotating echoes and omitted native fields, partial=%s",
  async (partial) => {
    const fake = rotatingIntercityFixture();
    const [listed] = await fake.client.list(account, "intercity");
    if (!listed) throw new TypeError("Missing ticket");
    const quote = await fake.client.quote(account, {
      ticket: listed,
      selection: partial ? { mode: "seats", seats: [2] } : { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(
      fake.requests.find((request) => request.url.includes("insertTckCan"))?.body,
    ).toMatchObject({ TCK_SEQ: partial ? "null" : "null:null" });
    expect(await fake.client.reconcile(account, quote)).toMatchObject({
      status: "confirmed",
      feeKrw: 1000,
      refundKrw: 19000,
    });
  },
);

test("does not count an old intercity cancellation again when its response owner rotates", async () => {
  let reads = 0;
  const old = { ...native("intercity"), BMG_COD: "4", SORT_DTE: "20261024120001" };
  const fake = fixture("intercity", (path, response) =>
    path.startsWith("selectMyPagePayList")
      ? {
          ...response,
          payList: [
            ...(fake.state.cancelled ? [] : [native("intercity")]),
            { ...old, USR_SNO: `rotating-${++reads}` },
          ],
        }
      : response,
  );
  const quote = await fake.client.quote(account, {
    ticket: ticket("intercity"),
    selection: { mode: "all" },
  });
  await fake.client.cancel(account, quote);
  expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
});

for (const service of ["intercity", "express"] as const) {
  test(`${service} rejects a cancellation receipt whose date normalizes into another day`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "selectMyPagePayInfo2.do"
        ? { ...response, CAN_DTE: "20270230", CAN_TIM: "1200" }
        : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
  });
  test.each([
    { clock: "1200", confirmed: true, timestamp: "2026-10-24T12:00+09:00" },
    { clock: "1159", confirmed: false },
    { clock: "120042", confirmed: true, timestamp: "2026-10-24T12:00:42+09:00" },
    { clock: "120041", confirmed: false },
    { clock: "2400", confirmed: false },
    { clock: "1260", confirmed: false },
    { clock: "120060", confirmed: false },
    { clock: "120", confirmed: false },
    { clock: "12000", confirmed: false },
    { clock: "12:00", confirmed: false },
  ])(
    `${service} reconciles receipt timestamps at their reported precision`,
    async ({ clock, confirmed, timestamp }) => {
      const fake = fixture(service, (path, response) =>
        path === "selectMyPagePayInfo2.do" ? { ...response, CAN_TIM: clock } : response,
      );
      const original = await fake.client.quote(account, {
        ticket: ticket(service),
        selection: { mode: "all" },
      });
      const quote = { ...original, quotedAt: original.quotedAt + 42868 };
      await fake.client.cancel(account, quote);
      const result = await fake.client.reconcile(account, quote);
      expect(result).toEqual(
        confirmed
          ? { status: "confirmed", feeKrw: 1000, refundKrw: 19000, cancelledAt: timestamp }
          : { status: "unknown" },
      );
    },
  );
  test(`${service} reconciles numeric zero penalty and numeric refund receipt`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "selectMyPagePayInfo2.do" ? { ...response, PEP_CHA: 0, CAN_FEE: 13700 } : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toMatchObject({
      status: "confirmed",
      feeKrw: 0,
      refundKrw: 13700,
    });
  });
  test.each(
    [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "", "+1", " 1", "1 ", "1.5", "-1"].map((value) => ({
      value,
    })),
  )(`${service} rejects invalid receipt refund amounts`, async ({ value }) => {
    const fake = fixture(service, (path, response) =>
      path === "selectMyPagePayInfo2.do" ? { ...response, CAN_FEE: value } : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
  });
  for (const partial of [false, true]) {
    test(`${service} positively reconciles ${partial ? "partial" : "whole"} cancellation after one mutation and ACK`, async () => {
      const fake = fixture(service);
      const quote = await fake.client.quote(account, {
        ticket: ticket(service),
        selection: partial ? { mode: "seats", seats: [2] } : { mode: "all" },
      });
      const before = fake.requests.length;
      const result = await fake.client.cancel(account, quote);
      expect(result).toEqual({ acknowledged: true });
      expect(fake.requests.slice(before).map((request) => request.url.split("/").at(-1))).toEqual([
        "insertTckCanCad2.do",
        "tckResponse.do",
      ]);
      const mutation = fake.requests[before]?.body;
      expect(mutation?.[service === "express" ? "cad_fee" : "CAD_FEE"]).toBe("0");
      expect(mutation?.[service === "express" ? "usr_chk" : "USR_CHK"]).toBe(
        service === "express" ? "" : "1",
      );
      expect(await fake.client.reconcile(account, quote)).toEqual({
        status: "confirmed",
        feeKrw: 1000,
        refundKrw: 19000,
        cancelledAt: "2026-10-24T12:00:01+09:00",
      });
      expect(fake.requests.every((request) => !request.url.includes("autoCancel"))).toBe(true);
    });
  }
  test(`${service} reconstructs allowlisted mutation when persisted payload has extra keys`, async () => {
    const fake = fixture(service);
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, {
      ...quote,
      payload: { ...quote.payload, evil: "forwarded?" },
    });
    expect(
      fake.requests.find((request) => request.url.includes("insertTckCan"))?.body["evil"],
    ).toBeUndefined();
  });
  test.each(["business", "http", "malformed", "network"])(
    `${service} reports uncertain without mutation retry when %s fails`,
    async (failure) => {
      const fake = fixture(service, (path, response) => {
        if (path !== "insertTckCanCad2.do") return response;
        if (failure === "network") throw new TypeError("synthetic connection lost");
        if (failure === "http") return new Response("unavailable", { status: 503 });
        if (failure === "malformed") return new Response("{", { status: 200 });
        return { ...response, errCode: "12345" };
      });
      const quote = await fake.client.quote(account, {
        ticket: ticket(service),
        selection: { mode: "all" },
      });
      const error: unknown = await fake.client
        .cancel(account, quote)
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(GoBusError);
      if (!(error instanceof GoBusError)) throw new TypeError("Expected typed error");
      expect(error.code).toBe("cancellation_uncertain");
      expect(fake.requests.filter((request) => request.url.includes("insertTckCan"))).toHaveLength(
        1,
      );
      expect(fake.requests.some((request) => request.url.includes("tckResponse"))).toBe(false);
    },
  );
  test(`${service} returns unacknowledged while positive readback can prove cancellation when ACK fails`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "tckResponse.do" ? new Response("lost", { status: 503 }) : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    expect(await fake.client.cancel(account, quote)).toEqual({ acknowledged: false });
    expect((await fake.client.reconcile(account, quote)).status).toBe("confirmed");
  });
  test.each([
    "USR_SNO",
    "LIN_SNO",
    "ORD_SNO",
    "TIM_DTE",
    "TIM_TIM",
    "TER_SFR",
    "TER_STO",
    "SET_NO",
    "PEP_CHA",
    "CAN_FEE",
    "CAN_DTE",
    "CAN_TIM",
  ])(
    `${service} never claims cancellation when receipt %s mismatches or is missing`,
    async (field) => {
      const fake = fixture(service, (path, response) =>
        path === "selectMyPagePayInfo2.do" ? { ...response, [field]: undefined } : response,
      );
      const quote = await fake.client.quote(account, {
        ticket: ticket(service),
        selection: { mode: "all" },
      });
      await fake.client.cancel(account, quote);
      expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
    },
  );
  test.each([
    ...(service === "express" ? [{ field: "USR_SNO", value: "another-owner" }] : []),
    { field: "LIN_SNO", value: "another-line" },
    { field: "ORD_SNO", value: "another-order" },
    { field: "TIM_DTE", value: "20261026" },
    { field: "TIM_TIM", value: "150000" },
    { field: "TER_SFR", value: "other-origin" },
    { field: "TER_STO", value: "other-destination" },
    { field: "SET_NO", value: "03,04" },
    { field: "CAN_DTE", value: "20261023" },
  ])(`${service} rejects a valid but unrelated receipt %j`, async ({ field, value }) => {
    const fake = fixture(service, (path, response) =>
      path === "selectMyPagePayInfo2.do" ? { ...response, [field]: value } : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
  });
  test(`${service} never equates full disappearance with cancellation`, async () => {
    const fake = fixture(service, (path, response) =>
      path.startsWith("selectMyPagePayList") && fake.state.cancelled
        ? { ...response, payList: [] }
        : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
  });
  test(`${service} rejects old receipt even if active ticket disappears`, async () => {
    const old = { ...native(service), BMG_COD: "4", SORT_DTE: "20261024120001" };
    const fake = fixture(service, (path, response) =>
      path.startsWith("selectMyPagePayList") && !fake.state.cancelled
        ? { ...response, payList: [native(service), old] }
        : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
  });
  test(`${service} rejects changed remaining issuance after partial cancellation`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "selectBuyTckInfoList2.do" && fake.state.cancelled
        ? { ...response, tckList: [{ ...issued(service, 1), TISU_ID: "replacement" }] }
        : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "seats", seats: [2] },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
  });
  test(`${service} rejects changed remaining issuance tuple after partial cancellation`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "selectCanTckList.do" && fake.state.cancelled
        ? { ...response, ticketList: [{ ...candidate(service, 1), TCK_SEQ: "replacement" }] }
        : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "seats", seats: [2] },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
  });
  test.each(["LIN_SNO", "ORD_SNO", "TER_SFR", "TER_STO"])(
    `${service} rejects mismatched remaining candidate %s`,
    async (field) => {
      const fake = fixture(service, (path, response) =>
        path === "selectCanTckList.do" && fake.state.cancelled
          ? { ...response, ticketList: [{ ...candidate(service, 1), [field]: "foreign" }] }
          : response,
      );
      const quote = await fake.client.quote(account, {
        ticket: ticket(service),
        selection: { mode: "seats", seats: [2] },
      });
      await fake.client.cancel(account, quote);
      expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
    },
  );
  test(`${service} reports actual receipt fees when final penalty differs from quote`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "selectMyPagePayInfo2.do"
        ? { ...response, PEP_CHA: "2000", CAN_FEE: "18000" }
        : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({
      status: "confirmed",
      feeKrw: 2000,
      refundKrw: 18000,
      cancelledAt: "2026-10-24T12:00:01+09:00",
    });
  });
  test(`${service} propagates authentication failure for bound read-only refresh`, async () => {
    const fake = fixture(service, (path, response) =>
      path.startsWith("selectMyPagePayList") && fake.state.cancelled
        ? new Response("expired", { status: 401 })
        : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    await expect(fake.client.reconcile(account, quote)).rejects.toEqual(
      new GoBusError("authentication_required"),
    );
  });
  test(`${service} rejects contradictory active history after full cancellation`, async () => {
    const fake = fixture(service, (path, response) =>
      path.startsWith("selectMyPagePayList") && fake.state.cancelled
        ? {
            ...response,
            payList: [
              native(service),
              { ...native(service), BMG_COD: "4", SORT_DTE: "20261024120001" },
            ],
          }
        : response,
    );
    const quote = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    await fake.client.cancel(account, quote);
    expect(await fake.client.reconcile(account, quote)).toEqual({ status: "unknown" });
  });
}
