# VOOY account authorization

## Workers setup screen diagnosis (2026-11-05)

The new Workers URL's anonymous `/mcp/account` initialize and GET return 401
with the exact path-specific resource-metadata challenge. Its protected-resource
and authorization-server metadata return 200 with the expected HTTPS origin.

A read-only inspection of the live VOOY setup dialog and frontend asset
`use-connector-connection-dialogs-CBGJsqU1.js` confirmed that visible manual
header/token fields mean `usesManualAuth` is true. In this state the toggle is
labelled "자동 인증 사용" (an action, not the current mode), and `canSubmit`
requires both header name and token value. The supplied screenshot's empty
fields therefore explain the disabled submit button. The toggle switches to
automatic discovery without requiring a manually entered token.

That read-only inspection explained the disabled button, but did not explain
the original automatic-mode failure. The user confirmed that switching modes
did not resolve it. The following actual-client reproduction supersedes the
earlier mode-toggle suggestion.

## Workers new-origin registration repair (2026-11-05)

Observed with normal VOOY UI submissions and concurrent sanitized Worker tail:

| Scenario | VOOY response | Worker behavior |
| --- | --- | --- |
| Edit the existing old-origin connector, enter the new Workers account URL, automatic auth | HTTP 400, `auth_required`, `MCP authorization failed: HTTP 401` | MCP POST 401; no metadata or registration requests |
| Add a new MCP with the identical Workers URL, automatic auth | HTTP 200, `oauth_authorization_required: true`, `oauth_client_registration_required: false` | Resource/issuer metadata 200, registration 201, authorize 302, connect 303 then 200 |

The existing connector's safe read showed its stored endpoint still differed
from the new Workers URL, auth mode `oauth2`, and status `needs_reconnect`.
Automatic-mode validation omitted `auth_mode` in both attempts. The contrast
isolates the failure to the existing connector's edit path. Reuse of retained
old-origin OAuth state is a hypothesis about VOOY's uninspected backend, not a
confirmed internal mechanism. No server code defect was demonstrated or patched.

The requested new Workers connector was registered through the fresh-add UI,
and the browser reached the server's `/connect` page. The old connector was
preserved. The user subsequently completed GO authentication. After a rejected
form POST, a fresh GET `/connect` showed the connected account and the VOOY
return action. Completing that action produced a persisted VOOY connector with
`connected: true`, `connection_status: connected`, `auth_mode: oauth2`,
`custom_mcp.status: ready`, and 17 tools. Protected provider tool execution on
this new origin was not tested; no chat or financial operation was performed.

Only status, method, query-free paths and allowed response fields were observed;
no credentials or authorization URLs were retained. Temporary browser fetch
wrappers were restored, and the bounded Wrangler tail was stopped. No production
source changed, so no source regression suite was rerun for this configuration
repair. The actual VOOY failing and passing validation paths are the evidence.

## Stale form recovery repair (2026-11-05)

The rejected POST had the expected Origin and form Content-Type. A subsequent
GET showed the account already connected. The first failing user request was
not captured, so its exact initiating sequence remains unproven. A synthetic
reproduction confirms that replaying the pre-completion form after successful
authentication hits the rotated-CSRF check and previously returned only plain
`Request rejected`.

The rejection now retains HTTP 403 and all validation checks, and renders a
stateless page with a fixed GET `/connect` recovery link. It contains no session
details, forms or CSRF tokens. Following the link reads the current session;
completed authentication and pending OAuth authorization are preserved. Invalid
requests never execute the original action. Tests cover completing the OAuth
exchange after recovery without a second provider authentication call, plus
cross-origin finish/disconnect/authorize, missing-CSRF and wrong-content-type
rejection. Evidence: `.omo/evidence/stale-csrf-recovery/`.

Validation: 1,138 Bun tests and 8 workerd tests passed. Both TypeScript checks
and Biome passed with six pre-existing informational diagnostics. An isolated
real browser exercised stale consent and stale finish submissions, followed the
recovery link, and observed the correct current phase; synthetic provider start
and finish counts stayed at one each. Independent code review found no blockers.

Deployed Worker version: `f2bc00bb-04b2-4d0e-b106-f9ce52d17e32`.
The deployed endpoint probe used a separate anonymous session without identity
input: stale consent returned HTML 403, recovery GET returned the identity phase
with 200, and anonymous `/mcp/account` remained 401. No live provider
authentication or financial call was made by this verification.

## Earlier local/tunnel authorization (2026-10-25)

Status: recovered. GO account authentication, VOOY OAuth issuance, persisted
connected state and the original protected `list_requests` result are verified.

## Observed failure

On 2026-10-25, the user completed standalone GO account connection after the
Toss continuation-metadata repair. Provider confirmation, required token refresh,
bus-account lookup and an aggregate persisted-account count of 1 confirmed it.
See `docs/toss-auth-diagnosis.md`.

The user's subsequent VOOY `list_requests` attempt reported disconnected. The
normal VOOY web app's `GET https://api.vooy.com/v1/connectors` returned these
projected fields for the existing connector:

```json
{
  "connected": false,
  "connection_status": "auth_failed",
  "auth_mode": "none",
  "custom_mcp.status": "auth_failed",
  "oauth_authorization_required": false,
  "oauth_client_registration_required": false,
  "tool_count": 17
}
```

Aggregate server counts for OAuth clients, pending authorizations, codes, token
families and tokens were all zero. A standalone GO connection had not authorized
VOOY. A direct unauthenticated protected call returned HTTP 401 with scope `mcp`
and the correct `/.well-known/oauth-protected-resource/mcp` discovery challenge.
The existing `/mcp` deliberately permits anonymous initialize, tools/list and
public queries. The observed VOOY setup did not initiate OAuth after discovery.
Its internal dispatch implementation remains uninspected.

## Repair contract

Added `/mcp/account`, which requires OAuth from the first MCP request. It has its
own exact resource URL and metadata path and shares issuer, OAuth endpoints,
storage and user-specific tool implementation. The original `/mcp` public-query
contract remains. Each token, authorization code and refresh token stays bound to its
selected resource; neither route accepts the other route's token.

The normal VOOY connector should then discover OAuth during initial validation.
Only after that visible setup succeeds should the user complete authorization
and retry the original read-only query. Do not put tokens in chat or manual
header fields, reuse the operator account, or infer grants from a saved GO account.

Separate exact resource metadata follows
[RFC 9728 section 3](https://www.rfc-editor.org/rfc/rfc9728.html#section-3).
The shared issuer does not relax existing resource binding.

## Verification before VOOY setup

Root ran the complete suite and type/lint checks. The initial 902 tests passed;
temporary authentication-observer files were then removed and the final 898
tests and checks passed. Six existing lint informational diagnostics remain.
An independent source audit found no blocking issue, with live VOOY behavior
explicitly outside its coverage.

The normal `src/index.ts` process replaced the diagnostic process. Through the
existing public Cloudflare URL, anonymous account-path initialize, tools/list
and tools/call each returned 401 with the exact account metadata URL. Both
resource metadata documents returned 200 with distinct exact resources and the
same issuer. An unknown resource returned 404. The real SDK still initialized
the public path, listed 17 tools and ran get_service_capabilities successfully.

Evidence: `.omo/evidence/vooy-oauth-entry/implementation.md`, `final-tests.log`,
`final-check.log`, `public-probe.ts` and `public-probe.log` in that directory.

## Actual VOOY discovery

Changed only the existing connector URL to `/mcp/account` through normal VOOY
settings. One save automatically opened the server's `/connect` authorization
page. Automatic auth, trust settings and all 17 enabled tools were retained.
The persisted connector now reports `auth_mode: oauth2`, `needs_reconnect`,
`oauth_authorization_required: true` and
`oauth_client_registration_required: false`. An aggregate server query confirmed
registered clients and a pending authorization, with no issued tokens yet.

The user chose to continue on their computer. The existing authorization page
identified the VOOY client origin and connector callback. The authorized account
consents were accepted, and the identity-entry page was brought to the foreground
in Aside. The user is entering their own identity and completing Toss approval;
the assistant will then confirm completion and follow the VOOY callback. Identity
values and the desktop authorization URL are not copied into chat or diagnostics.

The user subsequently chose mobile and completed the bound OAuth flow from
VOOY settings. Server aggregates confirmed one active token family and two token
records, including one unexpired access token. VOOY's normal connector read
returned oauth2, connected true, connection_status connected, custom_mcp.status
ready, both authorization/registration-required flags false and 17 tools. The
saved endpoint was present and matched `/mcp/account` exactly. The original
read-only `list_requests` retry was then requested from the user.

The user reported a successful actual VOOY `list_requests` call: 0 watches,
0 automatic booking requests, and notification delivery `inbox_only`. No new
request, reservation or payment was created. This is user-observed tool-result
evidence, separately supported by the persisted OAuth grant and VOOY ready state.

## Disposition

- Fixed now: missing private Toss continuation metadata, false pending-error
  classification, and VOOY's anonymous setup for an account-required workflow.
- Same-pattern prevention: browser and CLI preserve the same complete challenge;
  account initialize/discovery and tools require OAuth; wrong-resource tokens,
  code exchanges and refreshes remain rejected. Regression tests cover these
  boundaries and preserve anonymous public queries and user isolation.
- Intentionally unchanged: `/mcp` public query access, required provider token
  refresh, direct user identity approval, and inbox-only notification delivery.
- Separate unfinished work: provider-authenticated payment handoff and VOOY
  push delivery remain in the original task; neither was exercised by this repair.

Temporary auth observers and their logs were removed. The normal server is
running, with the grant persisted to its existing database. Final checks passed:
898 tests, no failures, type/lint exit 0 with six existing informational diagnostics.

## Acceptance

- Anonymous public MCP queries still work.
- Account-path initialization returns 401 and its own valid discovery metadata.
- Both resources complete OAuth with their own audience; cross-resource access,
  code exchange and refresh fail.
- Existing VOOY connector enters OAuth setup and completes its own grant.
- Actual VOOY `list_requests` succeeds without creating requests or transactions.
- Remove temporary diagnostics, restore the normal server, verify persisted grant.
