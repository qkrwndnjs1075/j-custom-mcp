import { GO_IDENTITY_TERMS_URL } from "./go-terms";
import { escapeHtml } from "./html";
import type { TossAppScheme } from "./toss-launch";

type ConnectionPhase = "consent" | "identity" | "waiting" | "connected" | "disconnected" | "error";
export type ConnectionPageModel = {
  readonly csrf: string;
  readonly message?: string;
  readonly restartUrl?: string;
  readonly oauth?: {
    readonly clientName: string;
    readonly clientOrigin: string;
    readonly redirectUri: string;
  };
  readonly challenge?: { readonly appScheme: TossAppScheme };
} & { readonly phase: ConnectionPhase };

export const CONNECTION_MESSAGES = {
  expired: "연결 시간이 만료됐어요. 처음부터 다시 진행해 주세요.",
  invalidIdentity: "이름, 휴대폰 번호, 생년월일을 확인해 주세요.",
  verificationUnconfirmed:
    "인증 완료를 확인하지 못했어요. 토스에서 완료 여부를 확인한 뒤 다시 시도해 주세요.",
  unavailable: "연결을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.",
  csrf: "이전 페이지에서 보냈거나 확인할 수 없는 요청이에요. 현재 연결 상태를 확인해 주세요.",
} as const;

const copy: Record<ConnectionPhase, { readonly title: string; readonly description: string }> = {
  consent: {
    title: "내 티머니GO 계정 연결",
    description:
      "계정을 연결하면 대화에서 계정 연결 상태와 이 서비스의 자동 예매 요청 상태를 조회하고, 원하는 조건으로 예매를 요청할 수 있어요.",
  },
  identity: {
    title: "본인 명의로 인증해 주세요",
    description: "티머니GO에 가입한 정보를 입력하면 토스로 인증 요청을 보내요.",
  },
  waiting: {
    title: "토스에서 인증해 주세요",
    description: "아래 버튼으로 토스를 열고 인증한 뒤 이 페이지로 돌아와 주세요.",
  },
  connected: {
    title: "계정이 연결됐어요",
    description: "이제 연결한 티머니GO 계정으로 이용할 수 있어요.",
  },
  disconnected: {
    title: "계정 연결을 해제했어요",
    description:
      "앞으로 이 연결로 자동 예매를 진행하지 않아요. 이미 발권된 승차권은 취소되지 않아요.",
  },
  error: {
    title: "연결을 다시 진행해 주세요",
    description: "계정 연결이 완료되지 않았어요. 아래 안내를 확인해 주세요.",
  },
};

type FormRoute = "consent" | "start" | "finish" | "disconnect" | "restart" | "authorize";
const html = escapeHtml;
function form(
  model: ConnectionPageModel,
  route: FormRoute,
  label: string,
  content = "",
  secondary = false,
) {
  return `<form method="post" action="/connect/${route}" class="form-stack">
    <input type="hidden" name="csrf" value="${html(model.csrf)}">
    ${content}<button class="button${secondary ? " secondary" : ""}" type="submit">${label}</button>
  </form>`;
}

function steps(phase: ConnectionPhase | "rejected") {
  const index = { consent: 0, identity: 1, waiting: 2 }[
    phase as "consent" | "identity" | "waiting"
  ];
  if (index === undefined)
    return `<p class="eyebrow">${phase === "connected" ? "연결 완료" : phase === "disconnected" ? "연결 해제" : "연결 확인"}</p>`;
  return `<ol class="steps" aria-label="계정 연결 단계">${["동의", "정보 입력", "토스 인증"]
    .map(
      (label, i) =>
        `<li${index === i ? ' aria-current="step"' : ""}><span aria-hidden="true">${i + 1}</span>${label}</li>`,
    )
    .join("")}</ol>`;
}

function clientContext(model: ConnectionPageModel) {
  if (!model.oauth) return "";
  return `<section class="context" aria-labelledby="client-title">
    <h2 id="client-title">연결을 요청한 서비스</h2>
    <dl><dt>서비스</dt><dd>${html(model.oauth.clientName)}</dd>
    <dt>서비스 주소</dt><dd dir="ltr">${html(model.oauth.clientOrigin)}</dd>
    <dt>연결 후 돌아갈 주소</dt><dd dir="ltr">${html(model.oauth.redirectUri)}</dd></dl>
  </section>`;
}

function consent(model: ConnectionPageModel) {
  return `${clientContext(model)}<section class="scope" aria-labelledby="scope-title">
    <h2 id="scope-title">연결하면 할 수 있는 일</h2>
    <ul><li>내 계정 연결 상태 조회</li><li>이 서비스에 맡긴 자동 예매 요청 상태 조회</li><li>명시적으로 요청한 조건 안에서만 예매</li></ul>
    <p class="hint">계정 연결만으로 결제하지 않아요. 예매에는 노선, 날짜, 인원, 최대 금액과 요청 유효시간이 필요해요.</p>
  </section>${form(
    model,
    "consent",
    "동의하고 계속하기",
    `
    <fieldset><legend>필수 동의</legend>
    <label class="check-row"><input type="checkbox" name="goTerms" value="yes" required><span>티머니GO 본인인증 개인정보 수집·이용에 동의합니다.</span></label>
    <a class="terms" href="${html(GO_IDENTITY_TERMS_URL)}" target="_blank" rel="noopener noreferrer">개인정보 수집·이용 동의 보기 <span>(새 창)</span></a>
    <label class="check-row"><input type="checkbox" name="accountAccess" value="yes" required><span>이 서비스의 계정 조회와 명시적으로 요청한 조건 내 예매에 동의합니다.</span></label>
    </fieldset>`,
  )}`;
}

function identity(model: ConnectionPageModel) {
  return form(
    model,
    "start",
    "토스로 인증 요청하기",
    `
    <div class="field"><label for="userName">이름</label>
    <input id="userName" name="userName" type="text" autocomplete="name" maxlength="80" required></div>
    <div class="field"><label for="userPhone">휴대폰 번호</label>
    <input id="userPhone" name="userPhone" type="tel" inputmode="tel" autocomplete="tel-national" pattern="[0-9]{10,11}" maxlength="11" aria-describedby="phone-hint" required>
    <p id="phone-hint" class="hint">숫자만 입력해 주세요. 예: 01012345678</p></div>
    <div class="field"><label for="userBirthday">생년월일</label>
    <input id="userBirthday" name="userBirthday" type="text" inputmode="numeric" autocomplete="bday" pattern="[0-9]{8}" maxlength="8" aria-describedby="birthday-hint" required>
    <p id="birthday-hint" class="hint">8자리로 입력해 주세요. 예: 19900101</p></div>
    <p class="notice">입력한 정보는 본인인증에 사용해요. 대화창에는 보내지 마세요.</p>`,
  );
}

function content(model: ConnectionPageModel): string {
  switch (model.phase) {
    case "consent":
      return consent(model);
    case "identity":
      return identity(model);
    case "waiting":
      if (!model.challenge)
        return `<p class="notice error" role="alert">${CONNECTION_MESSAGES.unavailable}</p>${form(model, "restart", "처음부터 다시 하기")}`;
      return `<a class="button" href="${html(model.challenge.appScheme)}" rel="noreferrer" referrerpolicy="no-referrer">토스 앱 열기</a>
      <ol class="instructions"><li>토스 앱에서 본인인증을 진행해 주세요.</li><li>인증을 마친 뒤 이 페이지로 돌아와 연결을 확인해 주세요.</li></ol>
      ${form(model, "finish", "인증했어요 · 연결 확인", "", true)}
      <p class="hint">요청이 보이지 않거나 시간이 지났다면 처음부터 다시 진행해 주세요.</p>
      ${form(model, "restart", "처음부터 다시 하기", "", true)}`;
    case "connected":
      return `<div class="notice"><p class="status-title">티머니GO 계정 연결 완료</p>
      <p>연결한 계정의 결제수단은 대화에서 확인할 수 있어요. 계정 연결만으로 결제하지 않아요.</p></div>
      ${model.oauth ? form(model, "authorize", "VOOY로 돌아가기") : ""}
      <details class="disconnect"><summary>계정 연결 관리</summary>
      <p class="hint">연결을 해제하면 앞으로의 자동 예매를 중단해요. 이미 발권된 승차권은 취소되지 않아요.</p>
      ${form(model, "disconnect", "계정 연결 해제", "", true)}</details>`;
    case "disconnected":
      return form(model, "restart", "계정 다시 연결하기");
    case "error":
      if (model.csrf) return form(model, "restart", "처음부터 다시 하기");
      return model.restartUrl
        ? `<a class="button" href="${html(model.restartUrl)}">새 연결 시작하기</a>`
        : '<p class="hint">연결을 요청한 서비스로 돌아가 계정 연결을 다시 시작해 주세요.</p>';
  }
}

export function renderConnectionPage(
  model: ConnectionPageModel | { readonly phase: "rejected" },
): string {
  const text =
    model.phase === "rejected"
      ? {
          title: "요청을 처리하지 않았어요",
          description: "이미 완료한 인증이나 연결은 이 요청으로 변경되지 않아요.",
        }
      : copy[model.phase];
  const message =
    model.phase === "rejected"
      ? CONNECTION_MESSAGES.csrf
      : model.message || (model.phase === "error" ? CONNECTION_MESSAGES.unavailable : "");
  const safeMessage = Object.values(CONNECTION_MESSAGES).some((value) => value === message)
    ? message
    : CONNECTION_MESSAGES.unavailable;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark"><meta name="robots" content="noindex,nofollow">
    <meta name="description" content="티머니GO 계정을 연결하고 본인인증을 진행합니다.">
    <title>${text.title} · 티머니GO 계정 연결</title><link rel="stylesheet" href="/connect/style.css">
    </head><body><a class="skip-link" href="#main">본문으로 건너뛰기</a><div class="shell">
    <header class="masthead"><span class="brand">버스 예매 도우미</span><span class="masthead-label">티머니GO 계정 연결</span></header>
    <main id="main" tabindex="-1"><div class="intro">${steps(model.phase)}<h1>${text.title}</h1><p class="description">${text.description}</p></div>
    ${message ? `<p class="notice error" role="alert">${safeMessage}</p>` : ""}
    <div class="content">${model.phase === "rejected" ? '<a class="button" href="/connect">현재 연결 상태 확인하기</a>' : content(model)}</div></main>
    <footer>티머니GO 계정을 사용하는 외부 연결 서비스입니다.<br>인증 정보는 대화에 공유하지 마세요.</footer>
    </div></body></html>`;
}
