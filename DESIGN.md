# Account connection design system

## 1. Atmosphere & identity

An existing utility, made readable on a phone. The previous checkout screen is a native HTML form with no custom visual system. This authorized extraction preserves native controls and document flow, then adds a reusable connection shell, form fields and action hierarchy. The signature is a quiet dark-ink masthead, a narrow warm canvas and a clearly numbered three-step journey. The masthead identifies 버스 예매 도우미; 티머니GO 계정 연결 is the task label. Footer explicitly identifies this as an external connector. Scope copy promises account connection status and this service's automatic booking request status, not all GO booking history. This is an account-permission screen, not a marketing page. No brand logos, decorative media or external assets.

Reference inputs: frontend architecture, minimalist execution, layout mechanics, perfection and designpowers review guidance. Spatial reference: [StyleGallery center](https://github.com/changeroa/StyleGallery/blob/main/patterns/centering/center.md), adapted as a fluid, maximum-width document. This is extraction from the existing UI, not a new brand concept. React tooling is inapplicable: the output is pure SSR HTML/CSS. Root owns the integrated browser and visual QA gate; static assertions cannot certify visual quality.

## 2. Color

| Token | Light | Dark | Purpose |
| --- | --- | --- | --- |
| --canvas | #f5f6f3 | #141917 | Page |
| --surface | #ffffff | #1c2420 | Form panel |
| --wash | #eef2ed | #26342c | Status / request context |
| --ink | #172b23 | #edf3ee | Main text / primary action |
| --muted | #536159 | #b3c2b8 | Supporting text |
| --line | #d5ddd6 | #4d6053 | Neutral boundaries |
| --action | #244d39 | #b9dfc3 | Primary button / links |
| --action-hover | #163726 | #d1eed8 | Hover |
| --on-action | #ffffff | #172b23 | Primary text |
| --error | #9b2934 | #ffc0c7 | Error text |
| --error-wash | #fff0f1 | #3c242a | Error background |
| --focus | #286ac7 | #92baff | Focus ring |

Accent belongs to actionable controls. Errors use text plus a tonal surface, never a colored edge stripe. No arbitrary raw colors outside the token declarations.

## 3. Typography

Font stack: `-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`. No font fetch. --text-sm 14px, --text-base 16px, --text-lg 18px, --text-title 28px. Body line-height 1.65; heading 1.35 with -0.035em tracking; labels 600 and title 700. Korean prose uses word-break keep-all and overflow-wrap anywhere. Input font stays 16px to avoid mobile zoom. URL metadata wraps anywhere without truncation.

## 4. Spacing & layout

Four-pixel base: --s1 4px, --s2 8px, --s3 12px, --s4 16px, --s5 20px, --s6 24px, --s8 32px, --s10 40px, --s12 48px. Content maximum --measure 480px; minimum touch control --control 52px; checkbox visual --check 22px inside a label at least 52px tall. Page has 20px horizontal padding; panel 24px, reduced to 20px below 360px. Header 32px above, footer 24px below. At 640px, outer vertical space grows to 48px. Document owns all scroll; no fixed CTA, inner scroll or clipped viewport. This keeps inputs and actions reachable with the phone keyboard open.

## 5. Components

- **Shell:** header identity, `main` panel, privacy footer. One H1 per phase, description directly beneath, phase marker above. Consent / identity / waiting use a semantic ordered three-step indicator and aria-current. Terminal states replace the indicator with status text.
- **Notice:** paragraph with tone variant normal or error; error has role alert. Server-owned fixed messages only; unknown raw messages are never reflected. No secret or identity values echoed.
- **Field:** visible label, native input, optional hint linked with aria-describedby. All three identity fields required, keyboard appropriate, and browser autocomplete specified. Default/focus/invalid states are native or token styled.
- **Consent row:** native required checkbox with full-row label hit area. GO terms link is separate from its label and names the new-tab behavior. Account access is a distinct required choice. Neither is prechecked.
- **Context:** client name, full origin and full redirect in a definition list before consent. Values are escaped and treated as text, not navigable links.
- **Action:** full-width native submit, primary or secondary, same 52px minimum height. Hover color change, active opacity, visible focus, disabled opacity. Account-connection POST forms contain exactly one hidden field: csrf. An error without a current csrf instead offers a native GET link to /connect, using the same button treatment and visible keyboard focus; it never submits an empty-token restart.
- **Status list:** semantic list of completed/pending facts, no PII. Waiting offers an explicit Toss launch button only for a validated provider-returned `appScheme`, followed by instructions to approve in Toss, return to this browser and check completion. Account connected means the existing-member GO connection succeeded; it does not imply Npay registration or payment readiness. Npay registration is not required to complete account connection.

The six rendered phase fixtures are the state harness for parent-owned browser QA, including error variants and malicious/long context strings. Browser QA must cover focus and checked states on actual primitives before release.

## 6. Motion & interaction

No scripted animation, automatic redirects or polling. Native form navigation communicates progress through the next page. Hover, pressed and focus feedback is instantaneous; reduced motion requires no special fallback because there is no motion. Waiting does not pretend to know approval progress: the user presses the Toss launch button, approves in Toss, returns to the browser and explicitly checks completion. A missing or invalid launch URI must not produce an invented app link. Restart is available after waiting/error.

## 7. Depth & surface

Express checkout uses the same shell, context, button, and hint tokens without a
new stylesheet. Its primary action opens GO app search; a secondary explicit
provider POST continues on a PC with the existing trip fields. The document owns
scrolling. Trip details and unreserved/unpaid status precede actions. The page
states the app's terminal-only prefill and required reselection; it never
automatically submits the desktop provider form or launches an external app.

Mixed neutral boundaries and tonal separation, no shadows. --radius-panel 20px; --radius-control 10px; --radius-notice 10px. Neutral 1px panel/input/secondary-button border; a softly tinted context/status surface. No colored one-sided border or decorative stripe. Outer panel and inner padding define concentric visual grouping.

## 8. Accessibility constraints & accepted debt

Target WCAG 2.2 AA: 4.5:1 body text, visible 3px keyboard ring with 3px offset, at least 44px hit areas, keyboard-native controls, single logical reading order, no placeholder-only labels, full zoom/reflow and no PII echo. `lang=ko`, viewport and color-scheme metadata, phase-specific title, skip link, live error text, and light/dark tokens. Users switching between browser and Toss need an explicit return instruction; low-vision users need wrapping URLs and scalable text; keyboard users need visible labels and focus.

No accepted accessibility debt. Integrated rendering, keyboard, mobile viewport, dark mode, and assistive-tech behavior remain verification work owned by the root agent; no unrun checks are claimed as passed.

## 9. Authentication and payment boundaries

Anonymous `initialize` and `tools/list` expose the same 16-tool inventory as an authenticated connection. Terminal, trip, seat and journey inquiries, capabilities, `get_payment_options({tripRef})` and official checkout preparation are public. Account status, watch tools and automatic booking tools require a connected OAuth subject. Protected HTTP calls return `401` with a `WWW-Authenticate` resource-metadata challenge. VOOY owns the authentication prompt and opening the connection page; this server does not implement a custom popup inside VOOY.

Connection uses existing-member Toss authentication. It establishes GO account access independently of payment registration. Anonymous payment discovery shows official card checkout and Npay as `requires_account`; authenticated discovery reads the caller's verified `npayaut` state. Other registered GO methods may be listed with `executionSupported: false`. Registration, executable support and successful issuance are distinct states. Inquiry errors remain unknown or require reconnection; secret payment data is never displayed.

`prepare_checkout` requires `payment: {method: "official_card"}` and returns `executionMode: "user_checkout"`. The user reselects seats, completes identity checks and enters card details on the official txbus site. This handoff does not reuse GO saved cards or held seats and is not booking confirmation. Automatic `book_trip` and `create_booking_request` still require explicit `naver_pay_auto`; the backend checks readiness before holding seats and again during payment preparation.

Public HTTPS reachability, actual VOOY OAuth interoperability, native mobile Toss launch/return and live GO authentication/payment remain unverified. School-network tunnel work is deferred. Browser fixture rendering alone cannot establish any of those outcomes.
