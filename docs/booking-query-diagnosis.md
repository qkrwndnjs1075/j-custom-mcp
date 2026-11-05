# Native intercity schedule date

On 2026-10-25 VOOY called book_trip once for the approved Daejeon complex to
Seosan departure on October 29 at 19:30, premium, adult1, seat5, 13700 KRW,
registered Npay. It returned failed/query. The persisted record had checkCount1,
no selection, no hold, no payment order and issueAttempted=false. VOOY independently
reported an empty intercity ticket list. Root did not retry the financial action.

Read-only reproduction used the exact stored trip. Credential refresh and the
3537-row terminal response succeeded. The schedule returned one LINE_LIST row
with no TIM_DTE field; the response envelope supplied the correct TIM_DTE instead.
GoBusRowSchema rejected the missing row date before selection or payment.

The adapter now inherits an omitted row date from the provider's envelope. It
still rejects a missing provider date or a date conflicting with the requested
departure, and retains exact allocation, segment, time and fare checks.

Regression tests first produced 13 pass / 3 fail, then 16 pass / 0 fail after
the fix. Read-only live reproduction then completed findTrip and readSeats,
confirmed seat5 selectable and expected total13700. No hold, payment reservation,
issuance or cancellation endpoint was allowed by the diagnostic transport.
Temporary diagnostics were removed. Actual purchase remains a VOOY user action.

Full verification: 930 tests passed, 0 failed, 3701 assertions across 81 files.
TypeScript and Biome pass with six existing informational diagnostics. A separate
read-only review found no date-safety regression. The normal server was restarted
with its existing public origin; local and public health checks both returned OK.
The user then explicitly authorized root to send the Korean retry command inside
VOOY and observe the result. That message was sent after exact draft comparison;
VOOY first reported no issued ticket and only the old failed request.

## Intercity hold response follow-up

The next VOOY call reached a hold but returned hold_uncertain. No parsed hold,
payment order or issuance attempt was stored; seat5 temporarily became unavailable.
The native model permits a string seat number without leading zeroes. The adapter
now normalizes one- or two-digit seat numbers, validates them against selected
seats and rejects duplicate seats or hold IDs. An absent ticket-kind echo inherits
the validated requested kind; present null, empty or mismatched kinds still fail.

Regressions failed before the change (46 pass,3 fail), then passed (49 pass,0 fail).
The full suite passed946 tests and3772 assertions across81 files; TypeScript and
Biome passed with the same six existing informational diagnostics.

A read-only provider basic-info query returned PCPY_BUY_TIM=5 minutes. At
06:15:11Z seat5 was selectable again and issued intercity tickets remained0.
After this check, root sent the authorized exact-trip request inside VOOY.
Its hold response at06:16:22Z was HTTP200/business00000 with SATS_NO as a
one-digit string, matching ticket kind, and a nonempty hold identifier. The hold
was successfully parsed and persisted. Only safe metadata was retained; no
identifier or raw provider response was logged. This confirms the live seat
format incompatibility, though the earlier response was not captured.

The new attempt stopped at reserve_uncertain with no persisted payment order
and issueAttempted=false. The reserve response was not retained, so its cause
cannot be inferred from this record. Independent issuance lookup remained unknown
and ticket list0. The user checked Npay history and reported no13700 KRW payment.
No actual ticket cancellation or refund was performed. Payment completion and
the eligible cancellation quote remain unverified.
