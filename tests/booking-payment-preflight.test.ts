import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { BookingRunner } from "../src/booking-runner";
import { TmoneyGoPurchaseClient } from "../src/go-purchase";
import { harness, specification } from "./booking-fixtures";

const active: ReturnType<typeof harness>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const item of active.splice(0)) {
    item.store.close();
    rmSync(item.directory, { recursive: true });
  }
});

const registered = {
  cardCpNm: "synthetic-card-private",
  cardNum4th: "9999",
  automaticPayId: "synthetic-billing-private",
  mbrsUseYn: "Y",
  displayYn: "Y",
};

function setup(reply: (inquiry: number) => Response) {
  const item = harness();
  active.push(item);
  const requests: { readonly path: string; readonly stage: string | undefined }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({ path: new URL(request.url).pathname, stage: item.store.records()[0]?.stage });
      return reply(requests.length);
    },
  });
  servers.push(server);
  const transport = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      return fetch(new Request(new URL(new URL(request.url).pathname, server.url), request));
    },
    { preconnect: fetch.preconnect },
  );
  return {
    ...item,
    requests,
    runner: new BookingRunner({
      ...item.options,
      purchase: new TmoneyGoPurchaseClient({ fetch: transport }),
    }),
  };
}

test.each([
  ["unregistered", null],
  ["omitted", undefined],
  [
    "malformed billing reference",
    { ...registered, automaticPayId: { secret: "synthetic-billing-private" } },
  ],
  ["disabled member use", { ...registered, mbrsUseYn: "N" }],
  ["hidden automatic method", { ...registered, displayYn: "N" }],
  ["missing billing reference", { ...registered, automaticPayId: undefined }],
  ["empty billing reference", { ...registered, automaticPayId: " " }],
  ["unknown member use", { ...registered, mbrsUseYn: "unexpected" }],
] as const)("fails before holding when Npay is %s", async (_label, info) => {
  const item = setup(() => Response.json({ rstCd: 200, dta: { npayautPymInfo: info } }));
  const created = await item.runner.create(specification());

  await item.runner.tick();

  expect(item.store.get(created.booking.id)).toMatchObject({
    stage: "failed",
    lastError: "payment_unavailable",
  });
  expect(item.requests).toEqual([{ path: "/api/pym/v2/inqrPymMnsListAtPym", stage: "watching" }]);
  expect(
    item.actions.filter(({ action }) => ["hold", "reserve", "issue", "release"].includes(action)),
  ).toEqual([]);
  expect(JSON.stringify(item.store.get(created.booking.id))).not.toMatch(
    /synthetic-(?:card|billing)-private|9999/,
  );
});

test.each([401, 403, 500])(
  "fails definitively without a hold or retry after preflight HTTP %i",
  async (status) => {
    const item = setup(() => new Response("synthetic-auth-private", { status }));
    const created = await item.runner.create(specification());

    await item.runner.tick();

    expect(item.store.get(created.booking.id)).toMatchObject({
      stage: "failed",
      lastError: "payment_unavailable",
    });
    expect(item.requests).toHaveLength(1);
    expect(item.actions.some(({ action }) => action === "hold")).toBe(false);
    expect(JSON.stringify(item.store.get(created.booking.id))).not.toContain(
      "synthetic-auth-private",
    );
  },
);

test.each([
  ["unregistered", null],
  ["member use revoked", { ...registered, mbrsUseYn: "N" }],
  ["automatic method hidden", { ...registered, displayYn: "N" }],
  ["billing reference removed", { ...registered, automaticPayId: null }],
] as const)(
  "releases the hold without billing when fresh preparation finds Npay %s",
  async (_label, revoked) => {
    const item = setup((inquiry) =>
      Response.json({ rstCd: 200, dta: { npayautPymInfo: inquiry === 1 ? registered : revoked } }),
    );
    const created = await item.runner.create(specification());

    await item.runner.tick();

    expect(item.store.get(created.booking.id)).toMatchObject({
      stage: "failed",
      lastError: "payment_unavailable",
      releaseAccepted: true,
    });
    expect(item.requests).toEqual([
      { path: "/api/pym/v2/inqrPymMnsListAtPym", stage: "watching" },
      { path: "/api/pym/v2/inqrPymMnsListAtPym", stage: "held" },
    ]);
    expect(item.actions.filter(({ action }) => ["hold", "release"].includes(action))).toEqual([
      { action: "hold", stage: "holding" },
      { action: "release", stage: "failed" },
    ]);
  },
);
