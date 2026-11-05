import { expect, test } from "bun:test";
import { BookingRecordSchema } from "../src/booking-types";
import { held as intercityHold, specification } from "./booking-fixtures";
import { expressSpec } from "./express-booking-inputs";
import { hold as expressHold } from "./go-express-fixtures";

test.each([
  { spec: specification(), hold: expressHold },
  { spec: expressSpec(), hold: intercityHold },
])("stored holds cannot cross the authorized bus service", ({ spec, hold }) => {
  const result = BookingRecordSchema.safeParse({
    id: crypto.randomUUID(),
    spec,
    hold,
    stage: "uncertain",
    bindingHash: "a".repeat(64),
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    nextCheckAt: 0,
    checkCount: 1,
    lastError: "issue_uncertain",
    selection: null,
    purchaseMonth: "202610",
    paymentOrderNumber: null,
    receiptBaseline: [],
    issueAttempted: true,
    releaseAccepted: null,
  });
  expect(result.success).toBe(false);
});
