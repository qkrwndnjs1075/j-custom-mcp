# Toss completion and GO account connection

Status: misleading pending classification and missing continuation metadata are
repaired. The user confirmed account connection, and server stages plus persisted
account count verified recovery. VOOY OAuth issuance, connected/ready state and
the original protected list_requests result are also verified.

## Confirmed classification defect

`TmoneyGoAuthClient` previously used `authentication_required` for non-success
Toss codes, any non-Y approval flag, and HTTP 401/403 from all authentication
endpoints, including mandatory token refresh. The connection handler interpreted
all of those errors while waiting as incomplete Toss approval.

The repaired handler retries only a fixed `verification_unconfirmed` result for
the supported N flag, with neutral wording. Unknown flags, rejected responses,
and failed refreshes produce a sanitized connection failure with a restart
action. Provider request fields and required refresh are unchanged.

Regression evidence: `.omo/evidence/toss-completion/classification/review.md`.
The fail-first test run had 9 failures. Targeted authentication and connection
coverage then passed 76 tests. Full run, including three temporary diagnostic
projection tests, passed 879 tests; type/lint checks exited 0 with the same six
pre-existing informational diagnostics.

## Live evidence

- 2026-10-25 03:58:35 UTC: authentication start returned HTTP 200, outer code
  200, and provider code 0000.
- 03:58:45 and 03:58:47 UTC: result confirmation returned HTTP/outer 200, but a
  nonnumeric provider code was suppressed by the initial diagnostic format.
  No member approval/token result or subsequent token refresh was observed.
- The user reported the same pending message. This located the live failure
  before refresh, at the result-confirmation boundary; the next diagnostic
  projection established the provider code without exposing response contents.
- 04:03:36 UTC: a fresh start returned 0000. At 04:03:45, result confirmation
  returned E100 with the fixed meaning "authentication request is missing".
  The device/transaction pair matched the observed start. No Cookie header was
  sent; Set-Cookie was present but JSESSIONID was absent. No refresh followed.
- The user observed the repaired terminal failure message and reports returning
  directly to the browser after Toss completion. No native automatic result
  consumer was found in the inspected provider sources.
- 04:13:08 UTC: another start returned 0000. The isolated experiment retained
  applicable start cookies only for the matching device/transaction result call.
  At 04:13:19, the result still returned E100 with the same missing-request
  meaning. Request continuity matched and cookies were sent. No refresh followed.
  Cookie continuity alone therefore did not recover authentication.
- After the metadata repair, 04:19:53 UTC start returned 0000 and both required
  metadata fields were present as strings. At 04:20:09, result confirmation sent
  the complete metadata body and returned 0000, approval Y, existing member Y,
  and a token. Mandatory token refresh succeeded (HTTP/outer 200, token present),
  followed by successful bus-account lookup. The persisted connected-account
  count changed from 0 to 1. The user independently confirmed the connection
  completion screen. This verifies the targeted repair against the live provider.

No identity fields, transaction IDs, device IDs, cookie values, tokens, member
IDs, or raw provider responses are recorded in diagnostic artifacts.

## Contract findings

The historical provider source snapshot posts only the original start result's `txId` to
`/api/mbrs/auth/v2/toss/authResult`, accepts `rspCd: 0000`, and opens the returned
app scheme unchanged. That snapshot does not represent the current full body.

### Current deployed contract differs from the source snapshot

Public assets fetched on 2026-10-25 show that the result body now includes
`txId`, `reqSno`, `moappMbrsSno` from the start response and `encYn: "Y"`.
Our start schema discarded the latter two identifiers and the completion path
forwarded only `txId`. This is a concrete contract mismatch consistent with the
missing-request response. Successful live recovery after preserving those fields
confirmed this was the authentication defect.

Sources: [current completion caller](https://tiaapi.tmoney.co.kr:20328/tgospa/assets/TossVerification-DU5k0oS9.js),
[current start caller](https://tiaapi.tmoney.co.kr:20328/tgospa/assets/TossLogin-BNQWu7pB.js),
[current API definitions](https://tiaapi.tmoney.co.kr:20328/tgospa/assets/memberApi-BBLauQ8x.js).
Local copies are in `.omo/evidence/toss-completion/public-assets/`.

The targeted repair preserves required returned metadata through the private
browser challenge and sends the current result body. It keeps the already
accepted identity-start transport. The current frontend also encrypts identity
fields and compares an encrypted duplicate member identifier; this change does
not claim full frontend parity. No unused identity fields are decrypted, and
positive approval, existing membership, token validation and refresh remain
required. Missing metadata must fail safely without fabricated defaults.

The implementation now preserves that required metadata in the private challenge
and both browser/CLI completion callers. Targeted authentication, connection and
enrollment checks passed 92 tests. After the accompanying VOOY repair and removal
of temporary diagnostics, the final full run passed 898 tests; type/lint checks
passed with six existing infos.
An independent read-only review found no blocking issues. Evidence:
`.omo/evidence/toss-completion/challenge-contract/review.md`.

An independent request using a synthetic nonexistent transaction produced the
same E100 missing-request result. The actual attempt's matching start/result
pair ruled out a simple local transaction mismatch. The later deployed-contract
comparison identified the discarded continuation fields.

The provider frontend normally uses same-origin browser requests, preserving
browser cookies. It also supplies native token context when available. The
server client currently does neither for initial Toss authentication. The native
HTTP interceptor itself permits absent Authorization, and no mandatory guest-token
prerequisite was established. The isolated cookie-continuity experiment passed
14 synthetic checks but failed to recover the live flow. It was removed and is
not part of the production repair. The current deployed frontend, rather than
the historical source snapshot, supplied the missing result-request contract.

[Toss's official error-code reference](https://auth-docs.toss.im/auth/errorcode.html)
distinguishes incomplete, expired and exhausted result retrieval. Its code table
does not itself establish how the GO wrapper maps those outcomes.

## Final verification

- The user reran the original protected `list_requests` through VOOY and reported
  0 watches, 0 automatic booking requests and inbox_only notification delivery.
  No new request, reservation or payment was created.
- Temporary diagnostic code was removed; the normal server and public HTTPS
  account/public entrypoints passed verification.

## Separate VOOY authorization boundary

After verified GO account persistence, the user retried `list_requests` and VOOY
again reported disconnected. At 04:21 UTC, aggregate counts for OAuth clients,
pending authorizations, codes, token families and tokens were all zero. The
standalone GO connection had not granted VOOY an MCP access token. The dedicated
account entrypoint now initiates OAuth while retaining the public query contract.
After the user completed the bound flow, a persisted active token family and
access token were confirmed; VOOY reports oauth2, connected, ready and 17 tools.
The exact configured endpoint matches `/mcp/account`. See
`docs/vooy-oauth-diagnosis.md` for the separate client authorization repair.

No seat hold, purchase, cancellation or payment ran during this diagnosis.
