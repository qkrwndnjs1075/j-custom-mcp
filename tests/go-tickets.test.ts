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

test("quotes intercity with rotating response owners, omitted ticket order and native null sequence", async () => {
  const fake = rotatingIntercityFixture();
  const [listed] = await fake.client.list(account, "intercity");
  if (!listed) throw new TypeError("Missing ticket");
  const quote = await fake.client.quote(account, { ticket: listed, selection: { mode: "all" } });
  expect(quote.selected.map((row) => row.ticketSequence)).toEqual(["null", "null"]);
  expect(
    fake.requests.find((request) => request.url.includes("selectFeeInfo"))?.body,
  ).toMatchObject({ TCK_SEQ: "null:null" });
  expect(quote.payload).toMatchObject({ TCK_SEQ: "null:null" });
  for (const request of fake.requests)
    expect(request.body).toMatchObject({ USR_SNO: account.context.userNumber });
  expect(fake.requests.some((request) => request.url.includes("insert"))).toBe(false);
});

test.each(["TISU_ID", "PUB_DTE", "PUB_TER", "PUB_WIN", "PUB_SNO"])(
  "intercity requires %s even with a missing native sequence",
  async (field) => {
    const fake = rotatingIntercityFixture((path, response) =>
      path === "selectCanTckList.do"
        ? {
            ...response,
            ticketList: [1, 2].map((seat) => ({
              ...candidate("intercity", seat),
              TCK_SEQ: undefined,
              [field]: undefined,
            })),
          }
        : response,
    );
    await expect(
      fake.client.quote(account, { ticket: ticket("intercity"), selection: { mode: "all" } }),
    ).rejects.toBeInstanceOf(GoBusError);
    expect(fake.requests.some((request) => request.url.includes("selectFeeInfo"))).toBe(false);
  },
);

for (const service of ["intercity", "express"] as const) {
  test(`${service} accepts numeric zero cancellation fee and numeric refund amount`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "selectFeeInfo.do" ? { ...response, canFee: 0, tckFee: 13700 } : response,
    );
    const result = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    expect(result).toMatchObject({ feeKrw: 0, refundKrw: 13700 });
  });
  test.each(
    [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "", "+1", " 1", "1 ", "1.5", "-1"].map((value) => ({
      value,
    })),
  )(`${service} rejects invalid cancellation fee amounts`, async ({ value }) => {
    const fake = fixture(service, (path, response) =>
      path === "selectFeeInfo.do" ? { ...response, canFee: value } : response,
    );
    await expect(
      fake.client.quote(account, { ticket: ticket(service), selection: { mode: "all" } }),
    ).rejects.toBeInstanceOf(GoBusError);
  });
  test.each([{ value: undefined }, { value: null }])(
    `${service} applies native missing-sequence rules`,
    async ({ value }) => {
      const fake = fixture(service, (path, response) =>
        path === "selectCanTckList.do"
          ? {
              ...response,
              ticketList: [1, 2].map((seat) => ({ ...candidate(service, seat), TCK_SEQ: value })),
            }
          : response,
      );
      const operation = fake.client.quote(account, {
        ticket: ticket(service),
        selection: { mode: "all" },
      });
      if (service === "intercity")
        expect((await operation).selected.map((row) => row.ticketSequence)).toEqual([
          "null",
          "null",
        ]);
      else await expect(operation).rejects.toBeInstanceOf(GoBusError);
    },
  );
  test(`${service} requires ticket order unless the intercity native row omits it`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "selectBuyTckInfoList2.do"
        ? {
            ...response,
            tckList: [1, 2].map((seat) => ({ ...issued(service, seat), ORD_SNO: undefined })),
          }
        : response,
    );
    const operation = fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "all" },
    });
    if (service === "intercity") expect((await operation).orderNumber).toBe("order-1");
    else await expect(operation).rejects.toBeInstanceOf(GoBusError);
  });
  test(`${service} still rejects an explicitly empty sequence`, async () => {
    const fake = fixture(service, (path, response) =>
      path === "selectCanTckList.do"
        ? {
            ...response,
            ticketList: [1, 2].map((seat) => ({ ...candidate(service, seat), TCK_SEQ: "" })),
          }
        : response,
    );
    await expect(
      fake.client.quote(account, { ticket: ticket(service), selection: { mode: "all" } }),
    ).rejects.toBeInstanceOf(GoBusError);
  });
  test(`${service} lists owned ordinary Npay tickets when native history is available`, async () => {
    const fake = fixture(service);
    const result = await fake.client.list(account, service);
    expect(result).toEqual([ticket(service)]);
    expect(fake.requests[0]?.url).toBe(
      service === "express"
        ? "https://exp.tmoney.co.kr/tgm/tgoapp/user/selectMyPagePayListSecu.do"
        : "https://icbusmob.tmoney.co.kr/tgx/tgoxzz/user/selectMyPagePayList.do",
    );
  });
  test(`${service} quotes net refund when provider fee semantics differ`, async () => {
    const fake = fixture(service);
    const result = await fake.client.quote(account, {
      ticket: ticket(service),
      selection: { mode: "seats", seats: [2] },
    });
    expect({
      seats: result.selectedSeats,
      fee: result.feeKrw,
      refund: result.refundKrw,
      remaining: result.remaining.map((row) => row.seat),
    }).toEqual({ seats: [2], fee: 1000, refund: 19000, remaining: [1] });
    expect(fake.requests.every((request) => !request.url.includes("insert"))).toBe(true);
  });
  test.each([
    ...(service === "express" ? ["USR_SNO"] : []),
    "LIN_SNO",
    "ORD_SNO",
    "TER_SFR",
    "TER_STO",
    "TISU_ID",
    "SET_NO",
  ])(`${service} rejects candidate mismatched %s before quoting`, async (field) => {
    const fake = fixture(service, (path, response) =>
      path === "selectCanTckList.do"
        ? {
            ...response,
            ticketList: [{ ...candidate(service, 1), [field]: "foreign" }, candidate(service, 2)],
          }
        : response,
    );
    await expect(
      fake.client.quote(account, { ticket: ticket(service), selection: { mode: "all" } }),
    ).rejects.toBeInstanceOf(GoBusError);
    expect(fake.requests.some((request) => request.url.includes("selectFeeInfo"))).toBe(false);
  });
  test.each([
    ...(service === "express" ? ["USR_SNO"] : []),
    "LIN_SNO",
    "ORD_SNO",
    "TIM_DTE",
    "TIM_TIM",
    "TER_SFR",
    "TER_STO",
    "TISU_ID",
    "SET_NO",
  ])(`${service} rejects issued ticket mismatched %s`, async (field) => {
    const fake = fixture(service, (path, response) =>
      path === "selectBuyTckInfoList2.do"
        ? {
            ...response,
            tckList: [{ ...issued(service, 1), [field]: "foreign" }, issued(service, 2)],
          }
        : response,
    );
    await expect(
      fake.client.quote(account, { ticket: ticket(service), selection: { mode: "all" } }),
    ).rejects.toBeInstanceOf(GoBusError);
  });
  test.each([{ cmplYn: "Y" }, { cmpl_yn: "y" }, { CMPL_YN: "Y" }])(
    `${service} rejects complex payment when seat wrapper says so %j`,
    async (extra) => {
      const fake = fixture(service, (path, response) =>
        path === "selectBuyTckInfoList2.do" ? { ...response, ...extra } : response,
      );
      await expect(
        fake.client.quote(account, { ticket: ticket(service), selection: { mode: "all" } }),
      ).rejects.toBeInstanceOf(GoBusError);
    },
  );
  test.each([{ DSC_TCK: "Y" }, { DCT_COD: "4" }, { DCT_COD: "5" }])(
    `${service} rejects discounted ticket %j`,
    async (extra) => {
      const fake = fixture(service, (path, response) =>
        path === "selectBuyTckInfoList2.do"
          ? { ...response, tckList: [{ ...issued(service, 1), ...extra }, issued(service, 2)] }
          : response,
      );
      await expect(
        fake.client.quote(account, { ticket: ticket(service), selection: { mode: "all" } }),
      ).rejects.toBeInstanceOf(GoBusError);
    },
  );
  test(`${service} reads account history whose opaque response identifiers differ from the request`, async () => {
    const fake = fixture(service, (path, response) =>
      path.startsWith("selectMyPagePayList")
        ? {
            ...response,
            payList: [
              { ...native(service), USR_SNO: "response-owner-a" },
              { ...native(service), LIN_SNO: "line-2", USR_SNO: "response-owner-b" },
            ],
          }
        : response,
    );
    expect(await fake.client.list(account, service)).toEqual([
      { ...ticket(service), ownerUserNumber: "response-owner-a" },
      { ...ticket(service), lineNumber: "line-2", ownerUserNumber: "response-owner-b" },
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.body[service === "express" ? "usr_sno" : "USR_SNO"]).toBe(
      account.context.userNumber,
    );
  });
  test(`${service} rejects malformed history before returning any tickets`, async () => {
    const fake = fixture(service, (path, response) =>
      path.startsWith("selectMyPagePayList")
        ? { ...response, payList: [native(service), { ...native(service), USR_SNO: null }] }
        : response,
    );
    await expect(fake.client.list(account, service)).rejects.toBeInstanceOf(GoBusError);
  });
  test(`${service} omits unsupported payment history`, async () => {
    const fake = fixture(service, (path, response) =>
      path.startsWith("selectMyPagePayList")
        ? { ...response, payList: [{ ...native(service), ADM_KND_COD: "1" }] }
        : response,
    );
    expect(await fake.client.list(account, service)).toEqual([]);
  });
  test.each([{ seats: [0] }, { seats: [99] }, { seats: [1, 1] }, { seats: [3] }])(
    `${service} rejects invalid selected seats %j`,
    async ({ seats }) => {
      const fake = fixture(service);
      await expect(
        fake.client.quote(account, {
          ticket: ticket(service),
          selection: { mode: "seats", seats },
        }),
      ).rejects.toBeInstanceOf(GoBusError);
    },
  );
}
