# Ticket history reads

Observed 2026-10-25 through the existing connected account. The user reported
that VOOY `list_tickets` failed for both express and intercity. No financial
operation was authorized or performed.

## Cause and correction

Both history endpoints returned HTTP 200 and provider result code `00000`.
All 23 express and 2 intercity history rows passed `nativeTicketSchema`.
The shared history reader then rejected the response because it required every
row's `USR_SNO` to equal the request's stored bus user handle.

That equality is not a provider contract. The express envelope and all its rows
shared one opaque response identifier, different from the request handle. The
two intercity rows had two distinct opaque response identifiers, both different
from the request handle. Native model/converter/caller inspection found plain
string pass-through and no corresponding equality check. No encryption algorithm
or conversion between these identifiers has been established.

The history reader now parses the authenticated account's response without that
invalid comparison. It still rejects malformed rows and provider errors.
`CancellationAccount` checks the local account/connection binding before and
after the read and after any token refresh. `CancellationService` binds generated
ticket references to that account; tenant storage and cancellation preflight
checks remain in place. Raw provider identifiers are not exposed in tool output.

The old synthetic test incorrectly equated a different response string with a
foreign account. Its replacement reproduces the observed provider contract and
asserts the original account handle is sent. Malformed-row and account-change
tests cover the actual rejection boundaries.

The tool description now states the existing supported subset: ordinary Npay
tickets. A zero count does not establish that no tickets exist under other
payment methods or unsupported discounts.

## Verification

- Before: both live list calls returned `GoBusError("response")` after successful
  provider responses. Evidence: `.omo/evidence/ticket-reads/owner-format-before.log`.
- Regression before correction: 52 pass, 2 fail, both failures at the invalid
  comparison. Evidence: `regression-red.log` in the same directory.
- Focused checks after correction: 86 pass, 0 fail. Evidence: `regression-green.log`.
- Same live provider calls after correction: express success, 3 supported
  tickets; intercity success, 0 supported tickets. Evidence: `after.log`.
- Full suite: 902 pass, 0 fail, 3619 assertions across 79 files. `bun run check`
  exited 0 with six existing informational diagnostics. Evidence:
  `full-tests.log` and `check.log` in the same directory.
- Account reconnection during a list read and reuse of a ticketRef after
  reconnection are rejected before a quote or financial operation.
- Normal `src/index.ts` restarted as PID 46042 in Terminal window 40701, with
  the existing tunnel unchanged. Public `/health` returned 200, `status: ok`.
- Temporary probe and journal removed.
- The user subsequently reported that both actual VOOY `list_tickets` calls
  succeeded: express 3 ordinary Npay ticket records, intercity 0, cancellation
  records 0. No booking, payment or cancellation was performed. Test 12 passed
  at the client surface as reported by the user.
- All three returned departures were before the observation date. Usage state
  was absent from the result, so these records do not establish valid upcoming
  tickets, unused tickets or cancellation eligibility. Refund settlement remained
  unverified; this is not evidence of a pending refund.

The earlier failure was reproduced deterministically and corrected in code. The
VOOY narrative calling it a temporary problem does not match that diagnosis.

Diagnostic output contains only statuses, schema field types, counts and
comparison booleans. Credentials, identity values and raw payment responses
were neither logged nor copied into fixtures.

## Cancellation binding continuation

The user subsequently requested the remaining failures be repaired. `quote`,
`cancel` and `reconcile` repeated the invalid request-handle versus response-owner
comparison. Tickets now carry the existing local account/connection binding,
and those operations require that binding to match the current account.
Response-to-response owner, trip, order and candidate checks remain intact.

Old persisted records remain readable. An absent binding grants no authority:
legacy prepared operations fail without provider IO, while submitting/uncertain
records remain uncertain. No migration backfills authority or deletes history.
Both services have regressions for opaque response owners, reconnects, changed
members and legacy records. Focused tests: 181 pass, 0 fail. Full suite at this
stage: 923 pass, 0 fail; type/lint check exited 0. Implementation evidence and
precise boundaries: `.omo/evidence/quote-binding/report.md`.

Live read-only history was fetched twice: all three supported express records
matched by public journey/seat data, with stable owner, line and local binding.
Detail for one past record matched its history owner, line, date, time and
terminals. Intercity returned zero supported records in both reads. Only boolean
comparisons and counts were logged in `live-stability.log` in that directory.
This validates retention of response-to-response checks, not an eligible quote.
No live cancellation quote, cancellation or refund has yet been observed.
