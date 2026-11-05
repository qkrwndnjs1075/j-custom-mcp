import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BookingRunner } from "../src/booking-runner";
import { BookingStore } from "../src/booking-store";
import { GoPurchaseError } from "../src/go-purchase";
import { GoPurchaseHttp } from "../src/go-purchase-http";
import { reserveFailureDiagnostic } from "../src/go-purchase-types";
import { harness, specification } from "./booking-fixtures";
import { basicResponse, context, fixture, hold, secret } from "./go-purchase-fixtures";

test.each([
  {
    response: () =>
      Response.json({
        rstCd: "E100",
        msg: secret,
        dta: { rspCd: "N123", authDataCard: secret, oderSno: secret },
      }),
    category: "provider_status",
    status: 200,
    codes: { rstCd: "E100", rspCd: "N123" },
  },
  {
    response: () =>
      Response.json({
        rstCd: 200,
        dta: { rspCd: "0000", authDataCard: secret, authDataAuth: null, oderSno: secret },
      }),
    category: "response_shape",
    status: 200,
    codes: { rstCd: "200", rspCd: "0000" },
  },
  {
    response: () =>
      Response.json({ rstCd: secret, dta: { rspCd: { secret }, authDataCard: secret } }),
    category: "response_shape",
    status: 200,
    codes: {},
  },
  { response: () => Response.json(null), category: "response_shape", status: 200, codes: {} },
  { response: () => Response.json([secret]), category: "response_shape", status: 200, codes: {} },
  { response: () => new Response(secret), category: "invalid_json", status: 200, codes: {} },
  {
    response: () =>
      Response.json({ rstCd: "E503", dta: { rspCd: "N503" }, msg: secret }, { status: 503 }),
    category: "http",
    status: 503,
    codes: { rstCd: "E503", rspCd: "N503" },
  },
])(
  "records only bounded reserve failure metadata",
  async ({ response, category, status, codes }) => {
    const fake = fixture((request) =>
      request.url.includes("autoReserve") ? response() : basicResponse(request),
    );
    const prepared = await fake.client.prepare(context, hold, "go-member");
    const error: unknown = await fake.client
      .reserve(context, prepared)
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GoPurchaseError);
    expect(error).toMatchObject({
      code: "reserve_uncertain",
      diagnostic: { stage: "reserve", category, httpStatus: status, providerCodes: codes },
    });
    expect(`${JSON.stringify(error)} ${Bun.inspect(error)}`).not.toContain(secret);
    if (!(error instanceof GoPurchaseError)) throw new TypeError("Expected purchase error");
    expect(error.cause).toBeUndefined();
    await expect(fake.client.reserve(context, prepared)).rejects.toMatchObject({
      code: "configuration",
    });
    expect(fake.requests).toHaveLength(2);
  },
);

test("persists sanitized reservation failure across store reopen without retrying", async () => {
  const fake = fixture((request) =>
    request.url.includes("autoReserve")
      ? Response.json({
          rstCd: "200",
          dta: { rspCd: "N123", oderSno: secret, authDataCard: secret, authDataAuth: secret },
          message: secret,
        })
      : basicResponse(request),
  );
  const prepared = await fake.client.prepare(context, hold, "go-member");
  const error: unknown = await fake.client
    .reserve(context, prepared)
    .catch((value: unknown) => value);
  const item = harness();
  try {
    const created = await item.runner.create(specification());
    item.hooks.reserve = () => {
      throw error;
    };
    await item.runner.tick();
    const stored = item.store.read(created.booking.id);
    expect(stored).toMatchObject({
      stage: "uncertain",
      lastError: "reserve_uncertain",
      failureDiagnostic: {
        stage: "reserve",
        category: "provider_status",
        providerCodes: { rstCd: "200", rspCd: "N123" },
      },
    });
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(item.store.get(created.booking.id)).not.toHaveProperty("failureDiagnostic");
    const reopened = new BookingStore(item.path, "synthetic-principal", () => item.state.now);
    try {
      expect(reopened.read(created.booking.id)).toEqual(stored);
      item.state.now += 600000;
      await new BookingRunner({ ...item.options, store: reopened }).tick();
      expect(item.actions.filter(({ action }) => action === "reserve")).toHaveLength(1);
      expect(item.actions.some(({ action }) => action === "issue")).toBe(false);
    } finally {
      reopened.close();
    }
  } finally {
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});

test.each(["transport", "timeout"] as const)(
  "keeps %s failures sanitized without retry",
  async (category) => {
    let calls = 0;
    const fetcher = Object.assign(
      async () => {
        calls++;
        if (category === "transport") throw new TypeError(secret);
        return new Promise<Response>(() => {});
      },
      { preconnect: fetch.preconnect },
    );
    const http = new GoPurchaseHttp({ fetch: fetcher, timeoutMs: 20 });
    const error: unknown = await http
      .post(context, "api/pym/npay/v1/autoReserve", {})
      .catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "reserve_uncertain",
      diagnostic: { stage: "reserve", category, providerCodes: {} },
    });
    expect(error).not.toHaveProperty("diagnostic.httpStatus");
    expect(`${JSON.stringify(error)} ${Bun.inspect(error)}`).not.toContain(secret);
    expect(calls).toBe(1);
  },
);

test("records authorization presence and type without its value or order identifier", () => {
  const diagnostic = reserveFailureDiagnostic(
    {
      rstCd: 200,
      dta: { rspCd: "0000", oderSno: secret, authDataCard: secret, authDataAuth: null },
    },
    200,
  );
  expect(diagnostic).toEqual({
    stage: "reserve",
    category: "response_shape",
    httpStatus: 200,
    providerCodes: { rstCd: "200", rspCd: "0000" },
    fields: {
      dataObject: true,
      order: { present: true, string: true, nonempty: true, withinBound: true },
      cardAuthorization: { present: true, string: true, nonempty: true, withinBound: true },
      authorization: { present: true, string: false, nonempty: false, withinBound: false },
    },
  });
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
});

test.each([
  { value: "", nonempty: false, withinBound: true },
  { value: "x".repeat(16385), nonempty: true, withinBound: false },
])(
  "reports empty and oversized authorization strings without retaining lengths or values",
  async ({ value, nonempty, withinBound }) => {
    const fake = fixture((request) =>
      request.url.includes("autoReserve")
        ? Response.json({
            rstCd: "200",
            dta: { rspCd: "0000", oderSno: secret, authDataCard: value, authDataAuth: secret },
          })
        : basicResponse(request),
    );
    const prepared = await fake.client.prepare(context, hold, "go-member");
    const error: unknown = await fake.client
      .reserve(context, prepared)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "reserve_uncertain",
      diagnostic: {
        category: "response_shape",
        fields: { cardAuthorization: { present: true, string: true, nonempty, withinBound } },
      },
    });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain("x".repeat(20));
    expect(fake.requests).toHaveLength(2);
  },
);

test.each(
  ["A".repeat(13), "E_123", "https://secret", -1, 1.5, null, {}, ["200"]].map((invalid) => ({
    invalid,
  })),
)("omits malformed provider codes", ({ invalid }) => {
  const diagnostic = reserveFailureDiagnostic({ rstCd: invalid, dta: { rspCd: invalid } });
  expect(diagnostic.providerCodes).toEqual({});
  expect(diagnostic.category).toBe("response_shape");
});

test("strips extra sensitive diagnostic properties and discards malformed diagnostics", () => {
  const safe = reserveFailureDiagnostic(null, 200);
  const error = new GoPurchaseError("reserve_uncertain", {
    ...safe,
    raw: secret,
    cause: secret,
    fields: { ...safe.fields, authDataCard: secret },
  });
  expect(error.diagnostic).toEqual(safe);
  expect(`${JSON.stringify(error)} ${Bun.inspect(error)}`).not.toContain(secret);
  expect(
    new GoPurchaseError("reserve_uncertain", { ...safe, httpStatus: secret }).diagnostic,
  ).toBeUndefined();
  expect(
    new GoPurchaseError("reserve_uncertain", { ...safe, providerCodes: { rstCd: secret } })
      .diagnostic,
  ).toBeUndefined();
});
