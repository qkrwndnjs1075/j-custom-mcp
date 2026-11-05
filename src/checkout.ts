import { randomBytes } from "node:crypto";
import { z } from "zod";
import { checkoutConstraints, officialCheckout } from "./checkout-target";
import { CONNECTION_STYLES } from "./connection-styles";
import { escapeHtml } from "./html";
import type { TripReferenceStore } from "./trip-references";

export function createCheckoutHandler(options: {
  readonly references: TripReferenceStore;
}): (request: Request) => Response | undefined {
  return (request) => {
    const route = /^\/checkout(?:\/([^/]+))?\/?$/.exec(new URL(request.url).pathname);
    if (!route) return undefined;
    const nonce = randomBytes(18).toString("base64");
    const headers = new Headers({
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        `default-src 'none'; form-action 'none'; ` +
        `script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
    });
    if (request.method !== "GET") {
      headers.set("Allow", "GET");
      return new Response("Method not allowed", { status: 405, headers });
    }
    const reference = z.uuid().safeParse(route[1]);
    const trip = reference.success ? options.references.get(reference.data) : undefined;
    if (!trip)
      return new Response("Checkout link expired or unavailable", { status: 410, headers });
    const target = officialCheckout(trip);
    if (!target)
      return new Response("Official checkout is unavailable for this trip", {
        status: 409,
        headers,
      });
    headers.set(
      "Content-Security-Policy",
      `default-src 'none'; form-action ${new URL(target.action).origin}; ` +
        `script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
    );
    const inputs = Array.from(
      target.body,
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    ).join("\n");
    headers.set("Content-Type", "text/html; charset=utf-8");
    const constraints = checkoutConstraints(trip);
    if (constraints) {
      headers.set(
        "Content-Security-Policy",
        `default-src 'none'; form-action ${new URL(target.action).origin}; ` +
          `style-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
      );
      const app = constraints.mobileAlternative;
      const date = `${trip.departureDate.slice(0, 4)}-${trip.departureDate.slice(4, 6)}-${trip.departureDate.slice(6, 8)}`;
      const time = `${trip.departureTime.slice(0, 2)}:${trip.departureTime.slice(2, 4)}`;
      const { adults, students, children } = trip.passengers;
      return new Response(
        `<!doctype html><html lang="ko"><head><meta charset="utf-8">` +
          `<meta name="viewport" content="width=device-width, initial-scale=1">` +
          `<meta name="color-scheme" content="light dark"><title>고속버스 예매 경로 선택</title>` +
          `<style nonce="${escapeHtml(nonce)}">${CONNECTION_STYLES}</style></head>` +
          `<body><div class="shell"><main class="content">` +
          `<header><p class="eyebrow">좌석 미확보 · 결제 미완료</p><h1>고속버스 예매 경로 선택</h1></header>` +
          `<section class="context" aria-label="선택한 출발편"><h2>${escapeHtml(trip.departureName)} → ${escapeHtml(trip.arrivalName)}</h2>` +
          `<p>${escapeHtml(date)} ${escapeHtml(time)}</p>` +
          `<p>${escapeHtml(trip.carrierName)} · ${escapeHtml(trip.busClassName)}</p>` +
          `<p>성인 ${adults}명 · 학생 ${students}명 · 아동 ${children}명</p></section>` +
          `<p>${escapeHtml(constraints.notice)}</p>` +
          `<section class="form-stack" aria-label="모바일 앱에서 다시 선택">` +
          `<a class="button" href="${escapeHtml(app.url)}">${escapeHtml(app.label)}</a>` +
          `<p class="hint">${escapeHtml(app.notice)}</p>` +
          `<p class="hint">앱이 열리지 않으면 티머니GO 앱을 직접 실행해 위 출발편을 다시 조회하세요.</p></section>` +
          `<form method="post" action="${target.action}">${inputs}` +
          `<button class="button secondary" type="submit">PC에서 코버스 좌석 선택</button></form>` +
          `<p class="hint">최종 금액과 좌석은 선택한 서비스에서 결제 전에 확인하세요.</p>` +
          `</main></div></body></html>`,
        { headers },
      );
    }
    return new Response(
      `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>티머니 좌석 선택</title></head><body>` +
        `<form method="post" action="${target.action}">${inputs}` +
        `<button type="submit">티머니 공식 사이트에서 좌석 선택 계속하기</button></form>` +
        `<script nonce="${escapeHtml(nonce)}">document.forms[0].requestSubmit();</script></body></html>`,
      { headers },
    );
  };
}
