# User payment authentication investigation

Date: 2026-10-25. Target: watch, hold, notify, user completes required payment
authentication, then independently verify the issued ticket.

## Latest user-selected path

On 2026-10-25 the user changed the payment requirement to using the connected
GO account's registered payment method, with no additional app. The user also
explicitly requires the purchase command to originate in VOOY. Current live
account inquiry confirms naver_pay_auto is registered, displayed, has a billing
reference, and passes canUseAutomaticNpay. The implemented book_trip adapter can
use that path. This does not prove a completed purchase; no live automatic
reservation, issuance or cancellation was performed during this investigation.

The earlier direct-authentication investigation below is historical. Its bounded
billCreate probe returned HTTP 200, rstCd 200 and rspCd 0000, with the expected
checkout/order/reserve shape, despite ordinary naver_pay showing not_registered.
Read-only page requests reached Naver login; no login or payment authorization
was performed. This rules out registration as a blocker to checkout creation,
but does not establish an external callback. Raw payment responses and tokenized
URLs were not logged or persisted. The temporary probe has been removed; safe
status evidence and the one-attempt marker remain under
`.omo/evidence/interactive-npay/`.

The user explicitly confirmed that GO/Npay authentication must be completed by
the user for each purchase. Approval on this service followed by automatic Npay
billing is not an accepted substitute.

## Current result

The registered Npay automatic-payment adapter cannot be described as user payment
authentication. The official-card checkout also cannot continue a GO hold: it
requires the user to select seats again. Neither path completes the requested flow.

The inspected GO APK has an interactive Npay purchase path, but it receives payment
authorization through its native WebView and then issues tickets using retained
journey and hold data. An external browser callback or completion query has not
been established. A checkout URL alone is insufficient.

The [official Npay FAQ](https://developers.pay.naver.com/support/faq/payment)
describes delivery to the merchant's configured `returnUrl` or popup
`onAuthorize` callback. It also rejects embedding its checkout in a merchant
iframe. Those merchant integration features do not establish that a third-party
MCP can change GO's callback or use GO's merchant credentials.

## Static provider evidence

Artifacts are under `.omo/evidence/provider/apk/` and are observations of an
inspected app package, not a provider-supported public API or a live payment test.

- `decoded/payment-presenter.java:10802`: `nPay_billCreate` sends member, service
  H/C, product, passenger count, and amount. This caller sends no external return
  URL or hold ID. `TiaApiInterface.java:96` maps it to `api/pym/npay/v1/billCreate`.
- `TxbusNPayBillResp.java` models `checkoutPage`, `oderSno`, and `reserveId`.
- `payment-fragment.java:10473`: attaches the response to `frgItem`, then starts
  the native payment activity with that journey state.
- `decoded/user-auth-20261025/tmoney-user-webbase-20261025.java:677`: restores
  `frgItem` from Intent extra `item`. Lines 769-772 attach the JavaScript bridge;
  lines 793-801 load the checkout page for this payment type.
- `decoded/user-auth-20261025/tmoney-user-checkout-20261025.java:1950`: names the
  interface `NpayBridge`. `getPayCallBackUrl()` returns null; no configurable
  external callback is used by the inspected base class.
- `decoded/user-auth-20261025/tmoney-user-callback-20261025.java:34`: parses the
  bridge result, requires `result=success` and `billAuthData`, and invokes the
  ordinary one-way issuance branch with retained journey data.
- `decoded/user-auth-20261025/tmoney-user-checkout-20261025.java:1805`: maps
  callback `billAuthData`, `oderSno`, and `spreadOut` into the issuance request.
  Authentication completion is therefore distinct from ticket issuance.

The missing contract is delivery of the authenticated payment result to the
external service, bound to the existing hold, without relying on the GO native
bridge and its serialized journey state. No callback address, completion-polling
API, or public held-seat deep link was established. Do not invent any of these.

## VOOY evidence

The signed-in web Connections screen was inspected read-only. Its custom MCP
dialog supports remote HTTP, an optional manual token, and a server-trust choice.
No connection, recipe, chat message, or setting was submitted or changed.

- [VOOY homepage](https://vooy.com/ko) links the mobile apps.
- [VOOY terms](https://vooy.com/ko/docs/terms), section 10, describe execution
  confirmation before purchases. This is not provider payment authentication.
- [VOOY UI article](https://blog.vooy.com/ko/blog/ui-bigbang) describes app
  notification settings, but does not document MCP background completion delivery.
- [Privacy policy](https://vooy.com/ko/docs/privacy/2026-08-11) describes task
  execution and replies through messenger channels. It does not establish a
  custom MCP completion webhook or mobile push guarantee.
- [MCP URL elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
  describes external user interaction when the client advertises support. VOOY
  support and mobile push behavior remain unverified; connection OAuth does not
  imply URL elicitation support.

The web app points to the mobile app for scheduled tasks and agents. Actual mobile
notification delivery and long-running MCP completion were not tested. No public
completion callback contract was found; this does not prove the feature absent.

## Required evidence before completing this goal

1. A supported payment callback or completion query bound to the GO hold. A final
   approval in our service followed by registered automatic payment is a different
   flow from provider authentication and was explicitly declined by the user.
2. An observed VOOY delivery path that reaches the user while the app is in the
   background, with enough information to complete the required action.
3. An explicitly authorized live transaction and independent issued-ticket lookup.
   Source inspection, synthetic payment results, and an opened checkout page do
   not establish those outcomes.

The scheduler improvement is independent progress toward this goal. It removes
extra inter-batch and post-work delays; it does not close the payment or push gaps.

## Verification of the implemented scheduler change

- `bun test`: 864 passed, 0 failed, 79 files, 3161 assertions.
- `bun run check`: TypeScript and Biome exited 0. Six pre-existing informational
  `useLiteralKeys` diagnostics remain in unrelated files.
- `bun run sandbox:check`: 17/17 tools passed over the isolated synthetic HTTP
  MCP server. This exercises existing automatic booking with synthetic responses,
  not the missing user-authentication path.
- `bun run .omo/evidence/scheduler/runtime-smoke.ts`: actual entrypoint health
  returned HTTP 200; SIGTERM exited 0 in about 2 ms with isolated empty storage.
- Deterministic scheduler/SQLite coverage includes all users in bounded batches,
  configured 5-second sweeps, per-watch 10-second reads, 15-second expiry,
  disconnection, added users, overlapping calls, and shutdown during work/sleep.

Self-review: the changed scheduler starts no parallel financial work and continues
to delegate interval/expiry checks to the existing runners. Default provider
minimum polling stays at 300 seconds because a supported faster production rate
was not established. No live hold, payment, issuance, or mobile push was performed.
The full user goal is incomplete; `tasks/todo.md` remains open.

## Follow-up contract audit

The second `naverPayBillCreate` declaration in `TiaApiInterface.java:108` was
traced to `tbike/ui/payment/PaymentViewModel.java:1709`, where the observed caller
is a bicycle/kickboard payment flow. Its response adds `payToken` but still hands
the checkout data to `naverBillCheckoutPageAndroid`. It does not establish a bus
hold continuation or an external callback and cannot be substituted for the bus
contract. No connected Tmoney/VOOY tool was available to supply another supported
integration path.

The [official 2026-08-14 partnership announcement](https://www.tmoney.co.kr/aeb/cmnctn/news/readNewsView.dev?bdSeqNo=4211)
describes GO API infrastructure for a named partner and planned bus integration;
it does not provide an individual-developer callback or access contract.
Provider-facing questions are prepared in `docs/integration-inquiries.md` and
have not been sent. These questions request the precise missing capabilities,
without asking the user to supply payment credentials or infer technical facts.

## Resumed investigation, 2026-10-25

The user authorized a live target: 2026-10-29 Daejeon complex to Seosan,
19:30 premium, adult 1, maximum 13700 KRW, with GO/Npay authentication performed
directly by the user. Cancellation authorization stops at a quote. This does not
authorize the registered automatic-payment adapter or actual ticket cancellation.

Selective extraction and string decoding closed the previously missing native
deep-link dispatcher branch. Artifacts under `decoded/loader-analysis/`:

- `DeepLinkManager.java:710`: `reservation/detail/expbus` passes bus type, line,
  date and terminal identifiers to the bus activity. It does not receive a
  pending-payment authorization callback or complete an external hold.
- `DeepLinkManager.java:2244`: `bus/ticket` selects
  `FROM_ALERT_TICKET_DETAIL`. The downstream start-type mapping and
  `BusDeepLinkInit.java:219` route it to existing ticket detail, not checkout.
- `DeepLinkManager.java:399`: `bus/schedule` takes start/end terminal IDs and
  requires app login for route prefill. `bus/linelist` carries date/time fields,
  but `BusDeepLinkInit.java:97` applies the hour to a normal search. It does not
  guarantee a selected 19:30 service, passenger, seat or payment continuation.

No supported external payment-result callback, completion query or same-hold
checkout entry was established after this trace. Opening an ordinary GO route
would require the user to select the trip and seat again; a purchase there could
independently validate ticket lookup and a cancellation quote, but would not
validate continuation of a seat held by this MCP server.

The signed-in VOOY web UI was rechecked without submitting changes. It explicitly
directs scheduled tasks, agents and messenger connections to the app. Public
notification documentation does not establish custom MCP completion delivery.
A possible next experiment is a user-created one-off app task that calls
`check_alerts`, with notification delivery observed while the app is backgrounded.
It remains an experiment until the client actually schedules, runs and delivers
it. No push endpoint or protocol capability is assumed from OAuth connectivity.
