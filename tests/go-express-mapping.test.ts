import { afterEach, expect, test } from "bun:test";
import { ExpressTripSchema } from "../src/provider-types";
import { context, fixture, stopFixtures, trip } from "./go-express-fixtures";

afterEach(stopFixtures);
const web = ExpressTripSchema.parse({
  service: "express",
  departureId: "021",
  arrivalId: "393",
  departureName: "Central City",
  arrivalName: "Seosan",
  departureDate: "20261030",
  departureTime: "142000",
  scheduledDepartureTime: "140000",
  carrierId: "53",
  busClassId: "1",
  carrierName: "Synthetic",
  busClassName: "Synthetic",
  adultCount: 1,
  studentCount: 1,
  childCount: 1,
  remainingSeats: 3,
  totalSeats: 28,
  adultFareKrw: 15000,
  fareQuotes: trip.fareQuotes,
  expressIdentity: {
    allocationDepartureId: "020",
    allocationArrivalId: "394",
    discountCode: "0",
    webCheckoutEligible: true,
    privateBusinessAccrual: "N",
    childSafetySeats: "N",
    accessibleSeats: "N",
  },
});
test("matches express boarding segment and original allocation without intercity route identifiers", async () => {
  // Given
  const fake = fixture();
  // When
  const mapped = await fake.bus.findTrip(context, web);
  // Then
  expect(mapped).toEqual(trip);
  expect(mapped.row).not.toHaveProperty("rotid");
  expect(fake.requests[0]?.url).toBe(
    "https://exp.tmoney.co.kr/tgm/tgoapp/k5/ticket/selectTimInfo2.do",
  );
  expect(await fake.requests[0]?.json()).toMatchObject({
    tim_dte: "20261030",
    tim_tim_i: "1400",
    ter_fr_i: "021",
    ter_to_i: "393",
    cal_flg: "0",
  });
});
for (const patch of [
  { terfri: "020" },
  { tertoi: "394" },
  { terfro: "021" },
  { tertoo: "393" },
  { timtim: "1430" },
  { timtimo: "1410" },
  { timdte: "20261031" },
  { busgrao: "2" },
  { corcodo: "54" },
]) {
  test(`rejects native express ${Object.keys(patch)[0]} mismatch before seats or mutation`, async () => {
    // Given
    const fake = fixture(() =>
      Response.json({ errCode: "00000", line_list: [{ ...trip.row, ...patch }] }),
    );
    // When
    const action = fake.bus.findTrip(context, web);
    // Then
    await expect(action).rejects.toMatchObject({ code: "trip_match" });
    expect(fake.requests).toHaveLength(1);
  });
}
test("rejects ambiguous native express allocations before seats or mutation", async () => {
  // Given
  const fake = fixture(() => Response.json({ errCode: "00000", line_list: [trip.row, trip.row] }));
  // When
  const action = fake.bus.findTrip(context, web);
  // Then
  await expect(action).rejects.toMatchObject({ code: "trip_match" });
  expect(fake.requests).toHaveLength(1);
});
test("rejects changed express adult fare before seats or mutation", async () => {
  // Given
  const fake = fixture(() =>
    Response.json({ errCode: "00000", line_list: [{ ...trip.row, adltfee: 15001 }] }),
  );
  // When
  const action = fake.bus.findTrip(context, web);
  // Then
  await expect(action).rejects.toMatchObject({ code: "fare_changed" });
  expect(fake.requests).toHaveLength(1);
});
test("rejects unquoted selected express passenger before authenticated lookup", async () => {
  // Given
  const fake = fixture();
  const unquoted = ExpressTripSchema.parse({
    ...web,
    fareQuotes: { ...web.fareQuotes, students: null },
  });
  // When
  const action = fake.bus.findTrip(context, unquoted);
  // Then
  await expect(action).rejects.toMatchObject({ code: "fare_changed" });
  expect(fake.requests).toHaveLength(0);
});
