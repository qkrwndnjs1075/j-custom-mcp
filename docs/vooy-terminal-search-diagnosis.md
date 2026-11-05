# VOOY terminal-search failure investigation

Date: 2026-10-25. Status: connection state and chat terminal search recovered by
revalidation. The initiating authentication failure remains unconfirmed.

## Reported failure

The user reported that VOOY answered the capability prompt, then said Tmoney GO
was disconnected during Seosan terminal search and could not provide a connection
button. No tool name or underlying error was visible. VOOY's statement that it
notified its team is not independently verified.

## Observed boundaries

| Boundary | Observation |
| --- | --- |
| Local application | Unauthenticated express and intercity Seosan searches returned HTTP 200 and successful tool results. |
| Public Cloudflare URL | The same searches returned HTTP 200: express Seosan ID 393; intercity Seosan ID 3198101. |
| Public destination search | With VOOY Origin header, express departure 393 returned Central City (Seoul), ID 021. Intercity departure 3198101 returned Dongseoul and Seoul Nambu. |
| VOOY service settings | tmoney-go-bus connected; 17 tools; search_terminals checkbox enabled. No separate built-in Tmoney connector observed in the 33-service catalog. |
| VOOY failing invocation | User repeated the original prompt while ingress observation was active and reported the same disconnected response. No new request reached the application. |

The baseline diagnostic probe at 2026-10-25T02:52:20.088Z was made by Codex,
not VOOY. It reached search_terminals without Authorization and returned HTTP 200.
Do not count it as client end-to-end recovery.

At 2026-10-25T02:53:22Z, following the user's failed retry, the ingress log still
contained only that baseline probe. Cloudflare metrics remained at 23 proxied
requests (18 HTTP 200, 3 HTTP 202, 2 HTTP 401) with 0 proxy errors. The 401 counts
predate the retry and must not be attributed to it. This rules out an application
authentication or provider rejection for that retry. It does not distinguish a
VOOY dispatch gate from an outbound/network failure before this tunnel's origin.
The second probe explicitly named `tmoney-go-bus` and `search_terminals` with
`{"service":"express","query":"서산"}`. The user reported that VOOY said the tool
was listed but disconnected/unavailable to this account, and that it could not
send a connection button. At 2026-10-25T02:56:54Z, ingress and tunnel counters
were still identical. This is a second failed client attempt with no observed
origin request. The saved VOOY endpoint was independently checked and exactly
matches the live URL including `/mcp`.

## Structural audit

`src/auth-policy.ts` centrally classifies seven public tools. Both capability
lookup and terminal search use the same public path. Terminal search calls the
bus provider and has no GO-account dependency. Anonymous and authenticated
contexts use the same public provider.

`src/http.ts` intentionally rejects invalid credentials even for public tools.
An absent Authorization header permits public requests; an empty or invalid
header requires authentication. This affects capabilities and terminal search
equally, and is already covered by tests. Changing that policy without evidence
would hide a client/credential problem rather than establish the cause.

Validation: 49 tests passed, 0 failed, 133 assertions across HTTP authentication,
public-flow integration, payment-query authorization, and express provider tests.
TypeScript check passed with the temporary diagnostic entrypoint.

Cleanup and final control: the temporary diagnostic entrypoint, log, and journal
were removed. The ordinary `src/index.ts` process was restored with the same
public origin and tunnel. A real MCP SDK StreamableHTTP client completed connect,
tools/list (17 tools), and express Seosan search against the public endpoint,
returning terminal 393 without an error. This is an independent client control,
not evidence of VOOY recovery.

## Disposition

- Fix now: the evidence gap at ingress, using a temporary observer that emits
  timestamp, approved public tool name, RPC method, Authorization presence boolean,
  response status, and duration only. No token values, cookies, query arguments,
  request bodies, or provider responses are logged.
- Track externally: VOOY's runtime connector eligibility/dispatch and outbound
  transport. Its displayed account error is a reported conversational answer,
  not a captured internal exception. A VOOY request ID/backend log is required
  to identify the exact internal root cause. The failure remains unresolved.
- Intentionally unchanged: public authentication policy, provider adapters, tool
  schemas, and connector settings. Current evidence does not identify them as the
  cause; no speculative runtime fix is warranted.

The terminal-search test remains FAILED at the VOOY integration boundary.
Capability discovery must not be marked passed as an actual VOOY tool call solely
from its natural-language answer. Other tools using the same client dispatch may
be affected. No transaction is needed to reproduce this failure.

## Historical VOOY report draft before revalidation (not sent)

Subject: Custom MCP connected in service settings, but chat rejects account access before origin invocation

Custom connector: `custom_mcp_e6f9bc61d724`
Server: `tmoney-go-bus`
Endpoint: https://downloaded-improving-compensation-customise.trycloudflare.com/mcp

On 2026-10-25 around 11:52-11:57 KST, the service settings showed this custom
MCP connected with 17 enabled tools. Its exact saved endpoint matches the active
tunnel. `search_terminals` is checked.

In chat, both a normal Seosan-to-Central-City query and an explicit
`search_terminals({"service":"express","query":"서산"})` request were rejected.
The assistant said the tool exists but the connection is disconnected and
unavailable for this account, so it cannot provide a reconnect button.

During both retries the application received no MCP request and the tunnel's
proxied request count did not increase. A direct public HTTPS call to the same
tool returned HTTP 200 with Seosan terminal ID 393. The tunnel reported 0 proxy
errors. No Authorization header is required for this public query.

Please check the chat execution account/connector ownership, runtime tool-to-
connector mapping, eligibility/credential checks, and the relationship between
the stored connected state and execution state for this custom connector.
Please provide the internal error code/request ID and whether an outbound MCP
request was attempted, including its target origin and HTTP status if available.
The current evidence cannot distinguish a dispatch rejection from a network
failure before the origin. Reconnection has not been used to mask the mismatch.

## Gateway state inspection and recovery, 12:12-12:16 KST

Subsequent inspection of the normal page request to
`https://api.vooy.com/v1/connectors` (HTTP 200) returned these nonsecret fields for
`custom_mcp_e6f9bc61d724`:

```json
{"connected":false,"connection_status":"auth_failed","auth_mode":"none","custom_mcp.status":"auth_failed"}
```

There was no `can_use_now`, `last_error`, `error_code`, or `last_error_code` field.
All 17 tools were still enabled. This supersedes the earlier connected snapshot:
the current API state is now directly observed, not inferred from chat.

The publicly delivered frontend code separates the status badge from the endpoint
footer. `service-connector-status-DmySUsOH.js` maps `auth_failed` to the failure
badge. `service-connections-view-5VvJqEbA.js` renders the custom-MCP footer from a
populated `connected_account` without requiring `connected: true` in that branch.
Thus a stored endpoint can still be labelled connected while runtime status fails.

The normal reconnect action was observed, preserving the existing endpoint,
authentication configuration (`none`), trust, and all 17 enabled tools:

- POST `/v1/connectors/custom_mcp_e6f9bc61d724/connect`: HTTP 200,
  `success: true`, `state: connected`, `connected: true`, custom MCP `status: ready`.
- Subsequent GET `/v1/connectors`: HTTP 200, `connected: true`,
  `connection_status: connected`, `auth_mode: none`, custom MCP `status: ready`.
- Origin observation at 03:15:32 UTC: initialize 200, notifications/initialized
  202, tools/list 200; all without an Authorization header. No runtime tool was
  invoked during connection validation.

The recovery screenshot was inspected:
`/Users/park/.aside/u/0/sessions/2026-10-25_Ws6eU6k0ObawkQRi/tmp/mcp-restored-corrected.png`.

Public code references:
- https://app.vooy.com/assets/connectors-DDYMri_G.js
- https://app.vooy.com/assets/service-connector-status-DmySUsOH.js
- https://app.vooy.com/assets/service-connections-view-5VvJqEbA.js

The frontend submits custom validation through the existing connect endpoint with
`step_id: custom_mcp_validate`. The chat runtime invocation route and the internal
cause that originally set auth_failed are not exposed by these observations.
Connection-state recovery alone is not proof of a permanent fix. A user-run
search with concurrent sanitized ingress observation was requested.

At 03:17:19.593Z and 03:17:23.234Z, two `search_terminals` calls arrived after
normal initialize/initialized exchanges. Both lacked Authorization and returned
HTTP 200. Codex did not make those calls. This establishes resumed runtime
delivery after revalidation. The observer did not record result content or
`isError`. The user subsequently confirmed successful displayed results matching
Kobus terminal IDs 393 and 021. Together these observations pass terminal-search
test 2 through the actual VOOY runtime.

The normal `/ko/open-api` page explicitly says OPEN API is unavailable to the
current account and exposes no documentation links. No restricted routes were
probed. The chat-runtime invocation URL remains unknown; the observed management
endpoint must not be presented as the execution gateway's implementation.

## Final disposition

- Fixed now: the existing connector's failed persisted state was restored through
  its normal validation action, with unchanged endpoint, authentication, and tools.
- Verified: VOOY runtime terminal searches reached the origin and the user saw
  correct terminal IDs. Local provider/auth checks passed 49 tests.
- Follow-up: the event that originally set auth_failed is unconfirmed; normal
  revalidation is a demonstrated recovery, not a proven permanent root-cause fix.
- Follow-up: VOOY's saved-endpoint footer can disagree with its connection status.
- Intentionally unchanged: MCP business logic and public/private authorization
  policy. Evidence did not justify weakening authorization or adding a gateway.
- Remaining scope: other tool scenarios, private GO login, and payment are not
  established by this terminal-search test. The earlier unsent failure report is
  historical and must be updated before any external submission.

Cleanup completed: temporary gateway observer, journal, and sanitized log were
removed. The normal `bun src/index.ts` entrypoint was restored on port 8787;
both local and public HTTPS `/health` returned `{"status":"ok"}`. The existing
Cloudflare Tunnel and connector URL were preserved.
