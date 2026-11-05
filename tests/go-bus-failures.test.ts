import { expect, test } from "bun:test";
import { GoBusError } from "../src/go-bus";
import {
  context,
  failure,
  fixture,
  row,
  seatInfo,
  secret,
  terminalList,
  trip,
  web,
} from "./go-bus-fixtures";

test("does not hold after fare changes", async () => {
  // Given
  const fake = fixture(() => Response.json({ ...seatInfo, TCK_FEE1: "16000" }));
  // When
  const operation = fake.client.hold(context, {
    trip,
    seats: [{ seat: 1, passengerType: "adult" }],
  });
  // Then
  await failure(operation, "fare_changed");
  expect(fake.requests).toHaveLength(1);
});

test.each([
  { PCPY_LIST: [] },
  { PCPY_LIST: [{ SATS_NO: "02", SATS_PCPY_ID: "hold", BUS_TCK_KND_CD: "IG00" }] },
  { PCPY_LIST: [{ SATS_NO: "01", SATS_PCPY_ID: "", BUS_TCK_KND_CD: "IG00" }] },
  { PCPY_LIST: [{ SATS_NO: "1", SATS_PCPY_ID: "hold", BUS_TCK_KND_CD: "IC50" }] },
  { PCPY_LIST: [{ SATS_NO: "1", SATS_PCPY_ID: "hold", BUS_TCK_KND_CD: null }] },
  { PCPY_LIST: [{ SATS_NO: "1", SATS_PCPY_ID: "hold", BUS_TCK_KND_CD: "" }] },
  { PCPY_LIST: [{ SATS_NO: "1", SATS_PCPY_ID: "bad:hold" }] },
  ...["0", "00", "99", "001", " 1", "1.0", "2"].map((SATS_NO) => ({
    PCPY_LIST: [{ SATS_NO, SATS_PCPY_ID: "hold" }],
  })),
])("reports uncertain hold on missing or mismatched returned identity", async ({ PCPY_LIST }) => {
  // Given
  const fake = fixture((request) =>
    Response.json(
      request.url.endsWith("selectIbtInfo.do") ? seatInfo : { errCode: "00000", PCPY_LIST },
    ),
  );
  // When
  const operation = fake.client.hold(context, {
    trip,
    seats: [{ seat: 1, passengerType: "adult" }],
  });
  // Then
  await failure(operation, "hold_uncertain");
  expect(fake.requests).toHaveLength(2);
});

test.each([
  {
    PCPY_LIST: [
      { SATS_NO: "1", SATS_PCPY_ID: "first" },
      { SATS_NO: "01", SATS_PCPY_ID: "second" },
    ],
  },
  {
    PCPY_LIST: [
      { SATS_NO: "1", SATS_PCPY_ID: "same" },
      { SATS_NO: "2", SATS_PCPY_ID: "same" },
    ],
  },
])("rejects duplicate canonical seats or hold identifiers", async ({ PCPY_LIST }) => {
  const fake = fixture((request) =>
    Response.json(
      request.url.endsWith("selectIbtInfo.do")
        ? { ...seatInfo, SEAT_LIST: [{ "01": "Y", "02": "Y" }] }
        : { errCode: "00000", PCPY_LIST },
    ),
  );
  await failure(
    fake.client.hold(context, {
      trip: { ...trip, expectedTotalFareKrw: 30000 },
      seats: [
        { seat: 1, passengerType: "adult" },
        { seat: 2, passengerType: "adult" },
      ],
    }),
    "hold_uncertain",
  );
  expect(fake.requests).toHaveLength(2);
});

test("never retries a timed-out hold", async () => {
  // Given
  const fake = fixture(
    (request) =>
      request.url.endsWith("selectIbtInfo.do")
        ? Response.json(seatInfo)
        : new Promise<Response>(() => {}),
    30,
  );
  // When
  const operation = fake.client.hold(context, {
    trip,
    seats: [{ seat: 1, passengerType: "adult" }],
  });
  // Then
  await failure(operation, "hold_uncertain");
  expect(fake.requests).toHaveLength(2);
});

test.each([401, 500, 302])(
  "sanitizes HTTP failure %i without redirects or retries",
  async (status) => {
    // Given
    const fake = fixture(
      () => new Response(secret, { status, headers: { location: "http://127.0.0.1:1/leak" } }),
    );
    // When
    const operation = fake.client.lookupUser(context, "synthetic-member");
    // Then
    await failure(
      operation,
      status === 401 ? "authentication_required" : status === 302 ? "network" : "rejected",
    );
    expect(fake.requests).toHaveLength(1);
  },
);

test("rejects conflicting native aliases", async () => {
  // Given
  const fake = fixture(() =>
    Response.json({ errCode: "00000", ERR_COD: "99999", USR_SNO: secret }),
  );
  // When
  const operation = fake.client.lookupUser(context, "synthetic-member");
  // Then
  await failure(operation, "response");
});

test("rejects conflicting seat numbers instead of selecting a duplicate Y state", async () => {
  // Given
  const fake = fixture(() =>
    Response.json({ ...seatInfo, SEAT_LIST: [{ "01": "Y" }, { "1": "N" }] }),
  );
  // When
  const operation = fake.client.readSeats(context, trip);
  // Then
  await failure(operation, "response");
});

test("reports a business refusal without retrying the hold", async () => {
  // Given
  const fake = fixture((request) =>
    Response.json(
      request.url.endsWith("selectIbtInfo.do") ? seatInfo : { errCode: "99999", errMsg: secret },
    ),
  );
  // When
  const operation = fake.client.hold(context, {
    trip,
    seats: [{ seat: 1, passengerType: "adult" }],
  });
  // Then
  await failure(operation, "rejected");
  expect(fake.requests).toHaveLength(2);
});

test("does not treat HTTP 200 as release acceptance", async () => {
  // Given
  const fake = fixture(() => Response.json({ errCode: "99999", errMsg: secret }));
  const held = {
    trip,
    info: { tckfee1: "15000", totcnt: "4", seatlist: [] },
    seats: [{ seat: "01", holdId: "synthetic-hold", ticketKind: "IG00", passengerType: "adult" }],
  } as const;
  // When
  const operation = fake.client.release(context, held);
  // Then
  await failure(operation, "rejected");
  expect(fake.requests).toHaveLength(1);
});

test("reports uncertain release when its response is lost", async () => {
  // Given
  const fake = fixture(() => new Promise<Response>(() => {}), 30);
  const held = {
    trip,
    info: { tckfee1: "15000", totcnt: "4", seatlist: [] },
    seats: [{ seat: "01", holdId: "synthetic-hold", ticketKind: "IG00", passengerType: "adult" }],
  } as const;
  // When
  const operation = fake.client.release(context, held);
  // Then
  await failure(operation, "release_uncertain");
  expect(fake.requests).toHaveLength(1);
});

test("aborts an incomplete response body", async () => {
  // Given
  const fake = fixture(
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"errCode":'));
          },
        }),
      ),
    30,
  );
  // When
  const operation = fake.client.lookupUser(context, "synthetic-member");
  // Then
  await failure(operation, "timeout");
});

test("uses confirmed terminal aliases without losing the boarding segment", async () => {
  // Given
  const terminals = [
    { TER_COD: "00001", TER_COD2: "0000001", ARPR_TRML_YN: "A" },
    { TER_COD: "00002", TER_COD2: "0000002", ARPR_TRML_YN: "Y" },
  ] as const;
  const fake = fixture(
    () =>
      Response.json({
        errCode: "00000",
        line_list: [{ ...row, terfri: "00001", tertoi: "00002" }],
      }),
    1000,
    terminals,
  );
  // When
  const matched = await fake.client.findTrip(context, web);
  // Then
  expect(matched.row.terfri).toBe("00001");
  expect(matched.departureTerminal).toEqual(terminals[0]);
  const request = fake.requests[1];
  if (!request) throw new TypeError("Missing schedule request");
  expect(await request.json()).toMatchObject({ TER_FR_I: "0000001", TER_TO_I: "0000002" });
});

test("rejects ambiguous terminal aliases before querying schedules", async () => {
  // Given
  const fake = fixture(() => Response.json({ errCode: "00000", linelist: [row] }), 1000, [
    ...terminalList,
    { TER_COD: "0000001", TER_COD2: "another", ARPR_TRML_YN: "N" },
  ]);
  // When
  const operation = fake.client.findTrip(context, web);
  // Then
  await failure(operation, "trip_match");
  expect(fake.requests).toHaveLength(1);
});

test("invokes the final authorization guard after seat read and before holding", async () => {
  // Given
  const fake = fixture(() => Response.json(seatInfo));
  let guarded = false;
  // When
  const operation = fake.client.hold(context, {
    trip,
    seats: [{ seat: 1, passengerType: "adult" }],
    beforeMutation: async () => {
      guarded = true;
      expect(fake.requests).toHaveLength(1);
      throw new GoBusError("configuration");
    },
  });
  // Then
  await failure(operation, "configuration");
  expect(guarded).toBe(true);
  expect(fake.requests).toHaveLength(1);
});
