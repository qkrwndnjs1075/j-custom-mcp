# Terminal-only intercity departures

Observed 2026-10-25. VOOY reported two failed `search_trips` calls for
2026-10-29, Yuseong complex (3417501) to Seosan (3198101), adult 1, at
00:00 and 12:00. The error was `layout: Unrecognized dispatch row or availability
state`. These inputs differ from the user's requested Daejeon complex terminal
(3455101); the parser failure was nevertheless real and independently reproduced.

The provider's public dispatch table includes `.btn_noseat` rows labelled
`좌석 비지정 노선(터미널 직접구매)`. They have no seat-selection action.
The parser recognized only sold-out and disabled reservation buttons, so one
terminal-only row rejected the entire mixed page and hid bookable departures.

The parser now recognizes this button class and reports the explicit terminal
purchase status as `unavailable`. It creates no trip reference or seat count for
these rows. Unknown labels stay unknown; unexpected actions still reject.

## Verification

- A regression replacing the unavailable button on a mixed page with the
  observed terminal-only markup failed before the fix: 23 pass, 1 fail.
- After the fix, both parser test files pass: 24 pass, 0 fail. The added negative
  case retains rejection of an unexpected action on the new button class.
- Live provider 3417501 to 3198101 at 00:00: bookable 19:45 and 20:00;
  terminal-only 08:29 and 13:17, mobile-only 16:05, all retained as unavailable.
- Same route at 12:00: bookable 19:45 and 20:00; terminal-only 13:17 and
  mobile-only 16:05 retained as unavailable.
- The approved route 3455101 to 3198101 at 15:00 still returns 19:30,
  13700 KRW. All observations use 2026-10-29 and adult 1.
- Evidence: `.omo/evidence/intercity-layout/{red,green,live-provider}.log`.
- Full suite after this and the account-binding repair: 925 pass, 0 fail,
  3684 assertions across 81 files. `bun run check` exited 0 with six existing
  informational diagnostics. Evidence: `full-tests.log` and `full-check.log`.
- Normal server restarted as PID 51693 in Terminal window 41026. The existing
  public HTTPS `/health` returned 200/status ok. Both originally failed inputs
  and the approved Daejeon complex input succeeded through the public MCP
  endpoint. Evidence: the three `mcp-*.log` files in the same directory.
- The user reported the VOOY authenticated-client repeat succeeded with the
  exact Daejeon complex inputs: one 19:30 Chungnam premium departure, adult
  fare 13700 KRW, 20/28 seats, about 190 minutes, no next page and no error.
  That tool call was lookup only. The client-surface parser repair passed.

Self-review: the production delta adds one observed disabled-button selector
and one explicit unavailable label. It retains unknown-state and action checks,
schema parsing, pagination and passenger validation. No reservation identity is
invented for terminal-only rows. The local account-binding change was separately
reviewed against its account/reconnect and legacy-persistence regressions.

No hold, purchase, payment or cancellation endpoint was called by these probes. The temporary
provider diagnostic and debug journal were removed after these observations.

The same user report included VOOY's separate claim that it was progressing a
Bustago booking for Yuseong complex 20:00 based on a same-bus inference. That
claim is not transaction evidence. It also changes the approved boarding terminal
and departure time. Matching fare and seat count do not authorize substitution.
Further purchase steps must stop; if already submitted, check its status before
any retry. Actual ticket cancellation remains outside current authorization.
