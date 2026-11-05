import { afterEach, expect, test } from "bun:test";
import {
  context,
  fixture,
  hold,
  holdResponse,
  info,
  response,
  seatResponse,
  selection,
  stopFixtures,
  trip,
} from "./go-express-fixtures";

afterEach(stopFixtures);
test("reads express seats with native lowercase fields and undiscounted selected fares", async () => {
  // Given
  const fake = fixture();
  // When
  const result = await fake.bus.readSeats(context, trip);
  // Then
  expect(result).toEqual({ trip, info, selectableSeats: [1, 3, 4] });
  expect(fake.requests[0]?.url).toBe(
    "https://exp.tmoney.co.kr/tgm/tgoapp/k5/ticket/selectArrInfo.do",
  );
  expect(await fake.requests[0]?.json()).toEqual({
    tim_dte: "20261030",
    ter_fr: "020",
    ter_to: "394",
    tim_tim: "1400",
    ter_sfr: "021",
    ter_sto: "393",
    tim_tim_i: "1420",
    bus_gra: "1",
    cor_cod: "53",
    cur_ver: "1729",
    hp_cod: "A",
    ip_address: "",
    usr_sno: context.userNumber,
    os_ver: "34",
  });
});
test("holds and preserves all express seat/category pairs when provider returns unique holds", async () => {
  // Given
  const fake = fixture();
  // When
  const result = await fake.bus.hold(context, { trip, seats: selection });
  // Then
  expect(result).toEqual(hold);
  expect(fake.requests[1]?.url).toEndWith("/k5/ticket/insertPcpyNo.do");
  expect(await fake.requests[1]?.json()).toMatchObject({
    tim_tim_i: "1400",
    tim_tim: "1420",
    tot_cnt: "28",
    set_cnt: "3",
    set_no_web: "01:03:04",
  });
});
test("normalizes one-digit express response seats while preserving passenger identities", async () => {
  // Given
  const fake = fixture((request) =>
    request.url.endsWith("insertPcpyNo.do")
      ? Response.json({
          errCode: "00000",
          pcpy_list: [
            { set_no: "4", pcpy_no: "express-h4" },
            { set_no: "1", pcpy_no: "express-h1" },
            { set_no: "3", pcpy_no: "express-h3" },
          ],
        })
      : response(request),
  );
  // When
  const result = await fake.bus.hold(context, { trip, seats: selection });
  // Then
  expect(result).toEqual({ ...hold, seats: [hold.seats[2], hold.seats[0], hold.seats[1]] });
});
test.each(["0", "00", "99", "001", " 1", "1.0"])(
  "keeps express hold uncertain when provider seat is invalid: %s",
  async (set_no) => {
    // Given
    const fake = fixture((request) =>
      request.url.endsWith("insertPcpyNo.do")
        ? Response.json({
            errCode: "00000",
            pcpy_list: [
              { set_no, pcpy_no: "express-h1" },
              { set_no: "3", pcpy_no: "express-h3" },
              { set_no: "4", pcpy_no: "express-h4" },
            ],
          })
        : response(request),
    );
    // When
    const action = fake.bus.hold(context, { trip, seats: selection });
    // Then
    await expect(action).rejects.toMatchObject({ code: "hold_uncertain" });
    expect(fake.requests).toHaveLength(2);
  },
);
test("releases every express native hold using numeric count and colon delimiters", async () => {
  // Given
  const fake = fixture();
  // When
  await fake.bus.release(context, hold);
  // Then
  expect(fake.requests[0]?.url).toEndWith("/k5/ticket/deletePcpyNo.do");
  expect(await fake.requests[0]?.json()).toMatchObject({
    set_no: "01:03:04",
    pcpy_no_arr: "express-h1:express-h3:express-h4",
    pcpy_cnt: 3,
    ter_fr: "020",
    ter_to: "394",
    ter_sfr: "021",
    ter_sto: "393",
  });
});
for (const scenario of ["missing student fare", "changed child fare", "duplicate fare"] as const) {
  test(`rejects ${scenario} before express hold mutation`, async () => {
    // Given
    const fees = seatResponse.fee_list
      .filter((entry) => scenario !== "missing student fare" || entry.tck_knd_cd !== "9")
      .map((entry) =>
        scenario === "changed child fare" && entry.tck_knd_cd === "2"
          ? { ...entry, fee: "7501" }
          : entry,
      );
    if (scenario === "duplicate fare") fees.push({ tck_knd_cd: "1", dc_knd_cd: "0", fee: "15000" });
    const fake = fixture(() => Response.json({ ...seatResponse, fee_list: fees }));
    // When
    const action = fake.bus.hold(context, { trip, seats: selection });
    // Then
    await expect(action).rejects.toMatchObject({
      code: scenario === "duplicate fare" ? "response" : "fare_changed",
    });
    expect(fake.requests).toHaveLength(1);
  });
}
test("rejects unavailable seats before express hold mutation", async () => {
  // Given
  const fake = fixture();
  // When
  const action = fake.bus.hold(context, { trip, seats: [{ seat: 2, passengerType: "adult" }] });
  // Then
  await expect(action).rejects.toMatchObject({ code: "seat_unavailable" });
  expect(fake.requests).toHaveLength(1);
});
for (const scenario of [
  "partial",
  "duplicate seat",
  "duplicate normalized seat",
  "duplicate hold",
  "wrong seat",
  "malformed",
] as const) {
  test(`keeps express hold outcome uncertain when response is ${scenario}`, async () => {
    // Given
    const entries: { set_no: string; pcpy_no: string }[] = [...holdResponse.pcpy_list];
    if (scenario === "partial") entries.pop();
    if (scenario === "duplicate seat") entries[1] = { set_no: "01", pcpy_no: "h-extra" };
    if (scenario === "duplicate normalized seat") entries[1] = { set_no: "1", pcpy_no: "h-extra" };
    if (scenario === "duplicate hold") entries[1] = { set_no: "03", pcpy_no: "express-h1" };
    if (scenario === "wrong seat") entries[1] = { set_no: "02", pcpy_no: "h-extra" };
    const fake = fixture((request) =>
      request.url.endsWith("insertPcpyNo.do")
        ? Response.json({ errCode: "00000", pcpy_list: scenario === "malformed" ? null : entries })
        : response(request),
    );
    // When
    const action = fake.bus.hold(context, { trip, seats: selection });
    // Then
    await expect(action).rejects.toMatchObject({ code: "hold_uncertain" });
    expect(fake.requests).toHaveLength(2);
  });
}
test("does not repeat express hold when the provider returns HTTP 503 after submission", async () => {
  // Given
  const fake = fixture((request) =>
    request.url.endsWith("insertPcpyNo.do")
      ? new Response("unavailable", { status: 503 })
      : response(request),
  );
  // When
  const action = fake.bus.hold(context, { trip, seats: selection });
  // Then
  await expect(action).rejects.toMatchObject({ code: "hold_uncertain" });
  expect(fake.requests).toHaveLength(2);
});
