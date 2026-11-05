# Mobile express checkout routing

Date: 2026-10-25. Status: desktop auto-redirect fixed; live browser and actual
Android app launch with terminal prefill verified.

## Failure and cause

The user opened the prepared express checkout on Android and saw Kobus's
mobile-unavailable notice. `officialCheckout` selected a web POST based on trip
eligibility alone, and `/checkout/:tripRef` automatically submitted it on every
device. Payment discovery advertised this route as universally `available`.

Root reproduced the exact public flow with live read-only MCP calls for
2026-10-26 13:00, Seosan 393 to Central City 021, one adult. At a 390px browser
width, the provider navigated to `https://www.kobus.co.kr/mblIdx.do`, stating:
"모바일 환경에서의 서비스 이용은 고속버스 모바일 앱을 통해 가능합니다."
At 1440px the same Android user agent reached `/mrs/satschc.do` and seat selection.
A desktop user agent at 390px also reached the mobile notice. A user-agent-only
guard would miss this observed width-based behavior.

VOOY's short URL was inspected and is an external-navigation confirmation to
the MCP's checkout URL. It is not the provider payment page or the cause of the
mobile rejection.

## Repair

- Express checkout no longer automatically submits the desktop provider form.
  A responsive page shows the selected trip, unreserved/unpaid status, GO app
  navigation, and an explicit PC-only provider button.
- A shared constraint informs payment discovery (`requires_desktop`), preparation
  (`checkoutConstraints`), and capability output. The watch `booking_available`
  predicate still means provider web eligibility, documented separately from
  device usability.
- The existing provider form fields, eligibility, passenger/fare checks, and
  intercity behavior remain intact. No authentication or automatic-payment code
  changed.

## App route evidence and boundary

The APK's exported `TGoDeepLinkActivity` accepts `tmoneytia` (manifest line 649).
Routing-only extraction confirms:

```text
tmoneytia://bus/schedule?startID=<departureId>&endID=<arrivalId>
```

`.omo/evidence/mobile-checkout/DeepLinkManager-simple.java:2618-2619` dispatches
`bus/schedule` to `busSchedule`. The handler at `DeepLinkManager.java:301-337`
reads only `startID` and `endID`; it passes them when both are present and the app
is logged in, otherwise opens bus home. It does not consume travel date, departure
time, passengers, seats, or hold state. The page explicitly requires the user to
reselect them. This is fresh app navigation, not continuation of a GO hold.

The installed-package code established the navigation contract. The user then
opened the new public page on their actual Android phone and confirmed:
"티머니GO가 열리고 서산→센트럴시티가 설정됨". This verifies app launch and terminal
prefill for that device, not every platform or future app version. Full GO/Npay
user-authenticated issuance remains a separate unimplemented integration described
in `user-payment-handoff.md`.

## Verification

| Scenario | Evidence | Result |
| --- | --- | --- |
| Original 390px failure | `.omo/evidence/mobile-checkout/before-mobile.png` | Reproduced; root inspected screenshot |
| Regression before source fix | `implementation/red.log` under the same evidence directory | 2 passed, 8 failed |
| Related contracts after fix | `implementation/green.log` | 40 passed, 0 failed |
| Full suite | `tests.log` | 867 passed, 0 failed, 3199 assertions, 79 files |
| Type and formatting checks | `check.log` | Passed; six existing informational diagnostics |
| Public MCP and mobile page | `browser-after.log`, `after-mobile.png` | Correct route/date/passengers, app URI, no scripts, no overflow; no provider redirect |
| Public payment/capability contract | `live-contract.log` | `requires_desktop` and the same terminal-only app constraint are returned by the running server |
| Explicit desktop action | `browser-after.log`, `after-desktop-provider.png` | Correct Kobus seat-selection page; no seats selected |
| Actual Android app launch | User confirmation on 2026-10-25 | GO opened with Seosan to Central City selected |

Root inspected the rendered page and provider destination. No live hold,
reservation, payment, or ticket issuance occurred. The normal server entrypoint
was restarted with the existing public tunnel URL. The optional skill-specific
audit script could not run with installed TypeScript 5.9; project TypeScript and
Biome checks succeeded, without dependency changes.

Self-review: the regression tests cover escaped visible provider names, expired
references, web-ineligible trips, unchanged desktop fields, and unchanged
intercity preparation. Source inspection found no added authentication bypass,
financial action, dependency, or temporary instrumentation. The browser profiles,
temporary reproduction script, and debugging journal were removed after keeping
the relevant logs, screenshots, and routing extraction evidence. The live process
is the normal `bun src/index.ts` entrypoint. The routing repair does not complete
the original held-seat payment goal. The temporary `launchVerification` metadata
was removed after actual-device confirmation; verification history belongs in
this report, while the tool contract retains the functional restrictions.
