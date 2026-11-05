import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { directInput, expressBookingFixture, expressSearch } from "./express-booking-fixture";

const active: Awaited<ReturnType<typeof expressBookingFixture>>[] = [];
afterEach(async () => {
  for (const fixture of active.splice(0)) await fixture.close();
});
async function setup() {
  const fixture = await expressBookingFixture();
  active.push(fixture);
  const result = await fixture.client.callTool({ name: "search_trips", arguments: expressSearch });
  const { trips } = z
    .object({ trips: z.array(z.object({ tripRef: z.uuid(), totalFareKrw: z.null() })) })
    .parse(result.structuredContent);
  const reference = trips[0]?.tripRef;
  if (!reference) throw new TypeError("Missing synthetic reference");
  return { fixture, reference };
}

test("direct express booking obtains missing public quote before authorizing the native hold", async () => {
  // Given an unquoted schedule reference, without an explicit get_seats call.
  const { fixture, reference } = await setup();
  // When
  const result = await fixture.client.callTool({
    name: "book_trip",
    arguments: directInput(reference),
  });
  // Then
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    booking: { stage: "booked", selection: { fareKrw: 34500 } },
  });
  expect(fixture.first.references.get(reference)?.totalFareKrw).toBe(34500);
  expect(fixture.calls.filter(({ path }) => path.endsWith("insertPcpyNo.do"))).toHaveLength(1);
});

test("direct express booking rejects an absent public quote before any native financial call", async () => {
  // Given
  const { fixture, reference } = await setup();
  fixture.state.quoteAvailable = false;
  // When
  const result = await fixture.client.callTool({
    name: "book_trip",
    arguments: directInput(reference),
  });
  // Then
  expect(result.isError).toBe(true);
  expect(fixture.first.store.records()).toHaveLength(0);
  expect(fixture.calls).toHaveLength(0);
});
