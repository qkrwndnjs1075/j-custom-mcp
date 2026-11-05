import { expect, test } from "bun:test";
import {
  common,
  context,
  failure,
  fixture,
  row,
  seatInfo,
  secret,
  trip,
  web,
} from "./go-bus-fixtures";

test("maps GO membership with native common body and identical bearer and JWT tokens", async () => {
  // Given
  const fake = fixture(() =>
    Response.json({ ERR_COD: "00000", USR_SNO: "mapped-bus-user", HP_NO: secret }),
  );
  // When
  const result = await fake.client.lookupUser({ ...context, userNumber: "" }, "synthetic-member");
  // Then
  expect(result).toBe("mapped-bus-user");
  expect(fake.urls).toEqual(["https://icbusmob.tmoney.co.kr/tgx/tgoxzz/user/getUsrSno.do"]);
  const request = fake.requests[0];
  if (!request) throw new TypeError("Missing request");
  expect(await request.json()).toEqual({ ...common, USR_SNO: "", MEM_SNO: "synthetic-member" });
  expect(
    Object.fromEntries(
      ["authorization", "jwt", "uuid", "device-uuid", "appcode", "tgo-agent"].map((key) => [
        key,
        request.headers.get(key),
      ]),
    ),
  ).toEqual({
    authorization: `Bearer ${secret}`,
    jwt: secret,
    uuid: "synthetic-device",
    "device-uuid": "synthetic-device",
    appcode: "MIC",
    "tgo-agent": "TGO/2.7.1(1729) ANDROID/14 KR",
  });
});

test("matches one exact GO allocation and segment while retaining native origin fields", async () => {
  // Given
  const fake = fixture(() =>
    Response.json({
      err_cod: "00000",
      LINE_LIST: [
        { ...row, rotid: undefined, ROT_ID: "00123", secret },
        { ...row, alcnsqno: "0008" },
      ],
    }),
  );
  // When
  const result = await fake.client.findTrip(context, web);
  // Then
  expect(result).toEqual({ ...trip, passengers: web.passengers, fareQuotes: web.fareQuotes });
  const metadata = fake.requests[0];
  if (!metadata) throw new TypeError("Missing terminal request");
  expect(await metadata.json()).toEqual({ ...common, IN_DATE: "00000000000000" });
  const request = fake.requests[1];
  if (!request) throw new TypeError("Missing request");
  expect(await request.json()).toEqual({
    ...common,
    TIM_DTE: "20261030",
    TIM_TIM_I: "0900",
    TER_FR_I: "0000001",
    TER_TO_I: "0000002",
    BUS_GRA_I: "9",
    CAL_FLG: "5",
    CNT_100: "1",
    JOB_DIV: "",
    REQ_REC_NUM: "99999",
    POP_YN: "N",
  });
});

test("uses the native schedule envelope date when rows omit it", async () => {
  const { timdte, ...nativeRow } = row;
  const fake = fixture(() =>
    Response.json({ ERR_COD: "00000", TIM_DTE: timdte, LINE_LIST: [nativeRow] }),
  );
  const result = await fake.client.findTrip(context, web);
  expect(result.row).toEqual(row);
});

test.each([
  { date: "20261031", rowDate: undefined },
  { date: "20261031", rowDate: row.timdte },
  { date: row.timdte, rowDate: "20261031" },
])("rejects a conflicting native schedule date", async ({ date, rowDate }) => {
  const fake = fixture(() =>
    Response.json({
      ERR_COD: "00000",
      TIM_DTE: date,
      LINE_LIST: [{ ...row, timdte: rowDate }],
    }),
  );
  await failure(fake.client.findTrip(context, web), "trip_match");
});

test("rejects a schedule with no provider departure date", async () => {
  const { timdte: _date, ...nativeRow } = row;
  const fake = fixture(() => Response.json({ ERR_COD: "00000", LINE_LIST: [nativeRow] }));
  await failure(fake.client.findTrip(context, web), "response");
});

test.each([
  { rows: [row, row] },
  { rows: [{ ...row, terfri: "099" }] },
  { rows: [{ ...row, timtim: "0900" }] },
  { rows: [] },
])("rejects ambiguous or mismatched journeys", async ({ rows }) => {
  // Given
  const fake = fixture(() => Response.json({ errCode: "00000", linelist: rows }));
  // When
  const operation = fake.client.findTrip(context, web);
  // Then
  await failure(operation, "trip_match");
});

test("reads native origin and segment separately and only selects Y seat states", async () => {
  // Given
  const fake = fixture(() => Response.json(seatInfo));
  // When
  const result = await fake.client.readSeats(context, trip);
  // Then
  expect(result.selectableSeats).toEqual([1]);
  expect(result.info).toMatchObject({
    vtr30: "10500",
    vtr50: "7500",
    vtr70: "4500",
    DIST: "100",
    BUS_CLS_PRIN_YN: "Y",
    SATS_NO_PRIN_YN: "Y",
  });
  const request = fake.requests[0];
  if (!request) throw new TypeError("Missing request");
  expect(await request.json()).toEqual({
    ...common,
    TIM_DTE: "20261030",
    TER_FR: "099",
    TER_TO: "088",
    TIM_TIM: "0900",
    TER_SFR: "001",
    TER_STO: "002",
    TIM_TIM_I: "0930",
    BUS_GRA: "1",
    COR_COD: "03",
    ROT_ID: "00123",
    ROT_SQNO: "01",
    ALCN_DT: "20261030",
    ALCN_SQNO: "0007",
    AFC_OWNER_DVS_CD: "01",
    APP_VER: "",
  });
});

test("holds one checked adult seat and releases exactly the returned hold identity", async () => {
  // Given
  const fake = fixture(async (request) => {
    if (request.url.endsWith("selectIbtInfo.do")) return Response.json(seatInfo);
    const body = await request.json();
    return Response.json(
      body.SATS_PCPY_DVS === "1"
        ? {
            errCode: "00000",
            PCPY_LIST: [{ SATS_NO: "01", SATS_PCPY_ID: "returned-hold", BUS_TCK_KND_CD: "IG00" }],
          }
        : { errCode: "00000" },
    );
  });
  const held = await fake.client.hold(context, {
    trip,
    seats: [{ seat: 1, passengerType: "adult" }],
  });
  // When
  const released = await fake.client.release(context, held);
  // Then
  expect(released).toEqual({ businessAccepted: true });
  const [, holdRequest, releaseRequest] = fake.requests;
  if (!holdRequest || !releaseRequest) throw new TypeError("Missing hold or release");
  const golden = {
    ...common,
    ROT_ID: "00123",
    ROT_SQNO: "01",
    ALCN_DT: "20261030",
    ALCN_SQNO: "0007",
    TER_SFR: "001",
    TER_STO: "002",
    SATS_PCPY_NUM: "1",
    SATS_NO: "01",
    BUS_TCK_KND_CD: "IG00",
    CTY_BUS_DC_KND_CD: "",
    DCRT_DVS_CD: "",
    RTRP_DEPR_DT: "00000000",
  };
  expect(await holdRequest.json()).toEqual({ ...golden, SATS_PCPY_DVS: "1", SATS_PCPY_ID: "" });
  expect(await releaseRequest.json()).toEqual({
    ...golden,
    SATS_PCPY_DVS: "2",
    SATS_PCPY_ID: "returned-hold",
  });
});

test.each([{ SATS_NO: "1", BUS_TCK_KND_CD: "IG00" }, { SATS_NO: "01" }, { SATS_NO: "1" }])(
  "accepts native hold seat formatting and omitted ticket-kind echo",
  async (identity) => {
    const fake = fixture((request) =>
      Response.json(
        request.url.endsWith("selectIbtInfo.do")
          ? seatInfo
          : { errCode: "00000", PCPY_LIST: [{ ...identity, SATS_PCPY_ID: "returned-hold" }] },
      ),
    );
    const held = await fake.client.hold(context, {
      trip,
      seats: [{ seat: 1, passengerType: "adult" }],
    });
    expect(held).toMatchObject({
      seats: [{ seat: "01", holdId: "returned-hold", ticketKind: "IG00", passengerType: "adult" }],
    });
    expect(fake.requests).toHaveLength(2);
  },
);

test.each([2, 3, 4])(
  "does not mutate for unavailable, unknown or missing seat %i",
  async (seat) => {
    // Given
    const fake = fixture(() => Response.json(seatInfo));
    // When
    const operation = fake.client.hold(context, {
      trip,
      seats: [{ seat, passengerType: "adult" }],
    });
    // Then
    await failure(operation, "seat_unavailable");
    expect(fake.requests).toHaveLength(1);
  },
);
