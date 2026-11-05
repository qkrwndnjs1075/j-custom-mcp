import { expect, test } from "bun:test";
import { createGoRefreshBody } from "../src/go-refresh";

test.each([
  [
    "2026-12-31T15:04:59Z",
    "2027-01-01 00:04:59",
    "AAECAwQFBgcICQoLc8tQPvR0gi/Vff+FGqZapcbrH2HLvC2AqA==",
  ],
  [
    "2026-02-28T14:59:58Z",
    "2026-02-28 23:59:58",
    "AAECAwQFBgcICQoLnmhqL3ChjESbsofbeWsmwCv0BJYD5mVaOQ==",
  ],
])("matches independent Java JCE at Seoul boundary %s", (instant, expectedDate, ciphertext) => {
  // Given
  const input = {
    device: { uuid: "synthetic-device", osVer: "34" },
    memberSerial: "123456789",
    salt: "synthetic-salt",
    now: new Date(instant),
  };
  // When
  const body = createGoRefreshBody(input, Buffer.from("000102030405060708090a0b", "hex"));
  // Then
  expect(body).toEqual({
    mbphHwId: "synthetic-device",
    moappMbrsSno: ciphertext,
    rnwlDtm: expectedDate,
    mbphOsVer: "34",
    moappVer: "2.7.1",
    mblOsKndCd: "A",
  });
});

test("rejects invalid dates without exposing salt", () => {
  // Given
  const input = {
    device: { uuid: "synthetic-device", osVer: "34" },
    memberSerial: "123",
    salt: "synthetic-secret",
    now: new Date("invalid"),
  };
  // When
  const action = () => createGoRefreshBody(input);
  // Then
  expect(action).toThrow("GO authentication configuration is invalid.");
});
