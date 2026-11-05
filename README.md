# j-custom-mcp

개인용 MCP 서버 프로젝트입니다. 현재 티머니GO 시외·고속버스 MCP를 구현하며,
다른 서비스의 MCP도 추가할 예정입니다.

## Tmoney GO bus MCP

Cloudflare Workers 배포 이름은 `joowon-custom-mcp`입니다. Workers용 실행 구조,
비밀 설정과 검증·배포 명령은 [Workers 운영 안내](docs/cloudflare-workers.md)에 있습니다.

VOOY가 버스 종류·승객·운행편·좌석·결제·감시 정책을 선택하고, 명시적인 도구 인자로 전달하는 사용자별 티머니GO 시외·고속버스 MCP 서버입니다. 시외버스는 txbus, 고속버스는 KOBUS로 조회하며 자동예매는 각 서비스의 GO 경로를 사용합니다. 서버는 제공자가 반환한 요금을 확인하고 요청한 조건을 실행합니다.

터미널·운행·좌석 조회와 공식 카드 결제 링크 준비는 로그인 없이 사용할 수 있습니다. 계정 조회·감시·자동예매에는 `VOOY → 이 서버의 OAuth 인증 → 사용자별 GO 계정` 연결이 필요합니다. GO 인증정보는 이 서버에 보관하고 VOOY에는 별도의 MCP 접근 토큰을 발급합니다. 2026-10-25 공개 HTTPS, VOOY 공개 조회, Android 앱 전환, 토스 인증 후 GO 계정 저장, VOOY OAuth 권한 발급과 개인 요청 목록 조회를 확인했습니다. 실제 결제·발권은 별도 검증이 필요합니다.

## 사용자 연결

1. 계정 조회·감시·자동예매를 쓰려면 운영자가 제공한 `https://서버주소/mcp/account`를 VOOY의 사용자 지정 MCP에 추가하고 인증 방식을 자동으로 설정합니다. 이 주소는 처음 연결할 때부터 OAuth를 요구합니다.
2. 서버가 OAuth 리소스 메타데이터를 포함한 `HTTP 401`과 `WWW-Authenticate`를 반환합니다. 인증 안내와 연결 페이지를 여는 동작은 VOOY가 담당합니다. 서버가 VOOY 안에 별도 인증 팝업을 띄우는 것은 아닙니다.
3. 열린 연결 페이지에서 클라이언트와 권한을 확인하고 동의한 뒤, 본인이 직접 정보를 입력해 토스 기존 회원 본인인증을 시작합니다. 대기 화면의 토스 열기 버튼은 제공자가 반환한 유효한 `appScheme`으로 앱을 엽니다. 토스에서 승인한 뒤 브라우저로 돌아와 완료 확인을 누릅니다. 계정 연결에는 Npay 등록이 필요하지 않습니다.
4. `get_payment_options({tripRef})`로 선택한 편의 결제 경로를 확인합니다. 예매는 승객 구성, 운행편 또는 검색 조건, 좌석 정책, 결제 방식, 전체 요금 상한과 승인 종료 시각에 명시적으로 동의한 경우에만 요청합니다.

사용자에게 터미널 명령, 세션 파일 업로드, 토큰·비밀번호·문자 인증번호의 채팅 입력을 요구하지 않습니다. 연결 관리와 해제는 서버의 `/connect`에서 진행합니다. `/connect` 단독 연결은 VOOY에 OAuth 권한을 발급하지 않으므로 VOOY 연결 설정에서 OAuth로 연결을 시작해야 합니다. 실제 권한 발급과 개인 요청 목록 조회 결과는 [검증 기록](docs/vooy-oauth-diagnosis.md)에 있습니다.

공개 조회만 쓰는 클라이언트에는 `/mcp`를 제공합니다. 이 주소의 `initialize`, `tools/list`와 공개 도구는 계정 연결 없이 사용할 수 있고, 보호된 도구 호출 때 OAuth를 요구합니다. 각 주소에서 발급받은 토큰은 해당 주소에서만 유효합니다.

인증 중 요청이 만료되면 ‘새 연결 시작하기’에서 새 OAuth 요청으로 동의부터 다시 진행합니다. 검증된 클라이언트의 복귀 주소와 PKCE 정보는 유지하고 만료된 요청은 재사용하지 않습니다. 브라우저 쿠키나 요청 정보를 잃었다면 VOOY에서 계정 연결을 다시 시작해야 합니다.

## 운영자 실행

Bun과 pnpm, 영속 디스크가 필요합니다.

```sh
pnpm install --frozen-lockfile
umask 077
export DATA_DIRECTORY="$PWD/data"
pnpm start
```

기본 주소는 `http://127.0.0.1:8787`, 상태 확인은 `/health`, MCP 경로는 공개 조회용 `/mcp`와 계정 연결용 `/mcp/account`입니다. 로컬 loopback HTTP는 개발용으로만 허용합니다. GO 앱 리소스가 없어도 서버는 시작하지만 **계정 연결을 완료할 수 없습니다**.

사용 가능한 계정 연결을 준비하려면 운영자가 GO 앱에서 추출·디코딩한 Android 리소스 XML 파일을 서버에 배치하고 `GO_APP_RESOURCES`에 절대 경로를 설정해야 합니다. 파일에는 서버가 사용하는 `crypt_key_salt` 항목이 있어야 합니다. 원본 앱과 리소스 파일은 저장소에 포함하지 않습니다. 리소스 내용이나 추출 값을 채팅·로그에 출력하지 말고 실제 운영 서버에 직접 준비하세요.

| 설정 | 기본값 | 용도 |
| --- | --- | --- |
| `PORT` | `8787` | Bun 수신 포트 |
| `MCP_HOSTNAME` | `127.0.0.1` | 수신 주소 |
| `MCP_BASE_URL` | 로컬 loopback 주소 | 외부에서 접근하는 HTTPS origin. 경로·쿼리 없이 지정 |
| `MCP_ALLOWED_HOSTS` | `localhost,127.0.0.1` | 허용 Host 이름, 쉼표 구분 |
| `MCP_ALLOWED_ORIGINS` | `app.vooy.com` | 허용 Origin의 호스트 이름, 스킴·포트 없이 쉼표 구분. 서버 자신의 호스트도 허용 |
| `DATA_DIRECTORY` | `data` | 사용자 계정·OAuth·감시·예매 데이터 |
| `MCP_LIMITS` | `{}` | 운영 한도 JSON. 생략한 항목만 서버 기본값 사용 |
| `GO_APP_RESOURCES` | 없음 | 운영자가 준비한 GO Android 리소스 XML 경로 |
| `GO_VAULT_KEY_FILE` | `DATA_DIRECTORY/accounts.sqlite.key` | 계정 암호화 키 경로. 새 저장소는 키 자동 생성 |
| `GO_OS_SDK` / `GO_OS_RELEASE` / `GO_COUNTRY` | `37` / `17` / `KR` | GO 요청에 사용하는 OS·국가 설정 |

공개 운영 시 TLS 프록시 뒤에 Bun을 두고 `MCP_BASE_URL=https://실제호스트`, `MCP_ALLOWED_HOSTS=실제호스트`를 설정합니다. 프록시는 올바른 Host를 보존해야 합니다. 요청 본문, Authorization, Cookie, URL 쿼리를 프록시·애플리케이션 접근 로그에 남기지 마세요. OAuth 코드와 체크아웃 링크도 접근 권한을 포함합니다.

### 로컬 서버를 Cloudflare Tunnel로 연결하기

2026-10-25 실제 Quick Tunnel을 통한 HTTPS 접속과 VOOY의 공개 도구 호출을 확인했습니다. [검증 기록](docs/tunnel-validation.md)은 공개 조회와 계정 권한 발급을 구분합니다.

터미널 하나에서 `cloudflared tunnel --url http://127.0.0.1:8787`을 실행해
임시 HTTPS 주소를 발급받습니다. 다른 터미널에서 그 주소를 `MCP_BASE_URL`에,
스킴을 제외한 호스트 이름을 `MCP_ALLOWED_HOSTS`에 설정한 뒤 `pnpm start`를
실행합니다. 기존 로컬 서버가 실행 중이라면 먼저 정상 종료하고 새 설정으로 시작합니다.
계정 연결용 주소는 해당 HTTPS 주소 뒤에 `/mcp/account`를 붙인 값입니다.
공개 조회만 제공할 때는 `/mcp`를 사용합니다.
GO 계정 연결에는 앞서 설명한 `GO_APP_RESOURCES` 설정도 필요합니다.

Quick Tunnel 주소는 재실행할 때 바뀌므로 서버 설정과 VOOY 연결 주소도 함께
바꿔야 합니다. Mac과 서버·터널 프로세스가 실행 중일 때만 접근과 감시가 가능합니다.
[Cloudflare 안내](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)는
Quick Tunnel을 개발·테스트 용도로 한정하고 SSE를 지원하지 않는다고 명시합니다.
이 서버의 MCP 클라이언트 버전에 따른 응답 방식까지 실제 터널에서 확인해야 합니다.
고정 주소나 장기 실행이 필요하면 계정 기반 Tunnel을 사용합니다.

계정 인증정보는 암호화된 `accounts.sqlite`에, MCP 토큰은 해시 형태로 `oauth.sqlite`에 저장합니다. 사용자별 감시·예매 DB는 `users/<서버 내부 ID>/`에 분리합니다. 여행 조건·예매 기록까지 모두 암호화되는 것은 아닙니다. 저장 디렉터리와 파일은 실행 계정만 접근하도록 관리하고, 서버를 정상 종료한 뒤 데이터와 암호화 키를 함께 안전하게 백업하세요. 기존 계정 DB의 키가 사라지면 복구할 수 없습니다. 파일 권한과 암호화만으로 같은 OS 계정에서 실행되는 에이전트나 프로세스를 격리하지는 못합니다.

## 도구

현재 애플리케이션은 다음 **17개** 도구를 등록하며, 로그인 전후의 도구 목록은 같습니다. 공개 도구는 `get_service_capabilities`, `search_terminals`, `search_trips`, `get_seats`, `find_journeys`, `prepare_checkout`와 `get_payment_options({tripRef})`입니다. `get_payment_options({service})`는 계정 조회이므로 인증이 필요합니다. 나머지 도구는 인증된 연결 계정이 필요합니다. 사용자 ID는 도구 입력으로 받지 않고 검증된 MCP 인증에서 결정합니다. Authorization 헤더를 보내면 공개 호출에서도 토큰을 검증하며, 잘못된 토큰을 익명 요청으로 처리하지 않습니다.

| 도구 | 용도 |
| --- | --- |
| `get_service_capabilities` | 실제 지원하는 승객·결제·할인·인증 방식과 설정된 운영 한도 조회 |
| `search_terminals` | 명시한 시외·고속 서비스의 출발·도착 터미널 검색 |
| `search_trips` | 명시한 승객 구성으로 운행편·요금·잔여좌석 조회 |
| `get_seats` | `tripRef`의 현재 좌석과 요금 재조회 |
| `find_journeys` | 명시한 구간·승객·정렬 순서에 따른 여정 비교 |
| `watch_trips` | 빈자리·웹 예매 가능 상태 감시 등록 |
| `list_requests` | 본인의 감시·자동예매 요청과 발권 확인 상태를 함께 조회 |
| `cancel_watch` | 감시 중단 |
| `check_alerts` | 저장된 알림 조회 |
| `get_payment_options` | `{tripRef}`로 해당 편의 결제 경로 조회, 또는 `{service}`로 연결 계정·결제 수단 상태 조회 |
| `prepare_checkout` | 공식 사이트에서 직접 결제할 수 있는 연결 링크 준비 |
| `book_trip` | 선택한 운행편과 승객별 좌석 정책으로 즉시 한 번 예매 시도 |
| `create_booking_request` | 명시한 조건·좌석 정책·주기로 감시 후 예매하도록 승인 |
| `cancel_booking_request` | 아직 감시 중인 자동예매 승인 중단 |
| `list_tickets` | 연결 계정의 승차권과 취소 요청 상태 조회 |
| `get_cancellation_quote` | 전체 또는 선택 좌석의 취소 수수료·환불 예상액 조회 |
| `cancel_ticket` | 사용자 승인 수수료를 재확인한 뒤 발권 승차권 취소 |

날짜는 `YYYY-MM-DD`, 시각은 `HH:mm`이며 한국시간입니다. 승객은 `passengers: {adults, students, children}`로 모두 명시합니다. `students`는 중고생이며 나이로 승객 유형을 추정하지 않습니다. 모든 인원이 0인 요청은 거절합니다. `search_trips`의 다음 페이지는 승객 구성을 포함한 같은 조건과 `continuation`으로 요청하고 `tripKey`로 중복을 구분합니다.

새 터미널·운행 조회, 감시·예매 조건에는 `service: "intercity" | "express"`를 반드시 지정합니다. 터미널 ID는 서비스별 원래 코드를 그대로 사용합니다. 예를 들어 고속버스 센트럴시티(서울)→서산은 `express`, `021`→`393`입니다. 이름이 같아도 다른 서비스의 터미널 코드로 바꾸지 않습니다. `tripRef`를 받는 도구는 참조에 저장된 서비스로 실행합니다.

```json
{
  "service": "express",
  "departureId": "021",
  "arrivalId": "393",
  "date": "2026-10-26",
  "time": "14:00",
  "passengers": { "adults": 1, "students": 0, "children": 0 }
}
```

위 예시는 `search_trips` 입력 형식이며 날짜는 실제 이용일로 바꿉니다. 고속버스는 요청 시각 이후의 당일 결과를 한 번에 반환하고, 시외버스는 `continuation`으로 다음 페이지를 읽습니다. 고속버스 운행 목록의 `adultFareKrw`, `totalSeats`, `totalFareKrw`는 확인 전 `null`일 수 있습니다. `get_seats`로 실제 요금·좌석 수를 확인하며, 학생 요금이 비어 있으면 임의로 성인 요금을 적용하지 않습니다.

`tripRef`는 설정된 유효시간 동안 메모리에 유지되며 재시작하면 다시 조회해야 합니다. 익명 조회의 참조는 개수 제한이 있는 공개 저장소에 보관하고 로그인 후에도 사용할 수 있습니다. 인증된 사용자가 새로 만든 참조는 본인 저장소에 보관하며 다른 계정의 도구에서는 사용할 수 없습니다. `get_seats`는 같은 참조에 최신 요금을 반영하지만 유효시간을 연장하지 않습니다. 조회 결과와 좌석 조회는 좌석 점유나 예매 완료를 의미하지 않습니다.

`fareQuotes`는 승객 유형별 단가와 제공자가 반환한 구분 코드이고, `totalFareKrw`는 요청한 전체 승객의 합계입니다. 운행 목록에서 일부 유형의 요금을 알 수 없으면 합계는 `null`이며 `get_seats`에서 확인해야 합니다. 성인 요금을 곱하거나 할인율을 임의로 추정하지 않습니다. 요금 상한도 전체 승객 합계에 적용합니다.

`find_journeys`의 각 구간은 `time`, `endTime`, `minSeats`, `passengers`, `ranking`을 명시합니다. 구간 `ranking`은 `preferred_time`, `fare`, `departure_time` 중 원하는 순서이며 `preferred_time`에는 `preferredTime`이 필요합니다. 여정 전체의 `ranking`은 `total_fare`, `total_preferred_time`, `leg_order` 중 원하는 순서입니다. `leg_order`는 입력한 구간 순서대로 각 구간의 정렬 조건을 적용합니다. 구간 수와 검색량은 운영 설정으로 제한하며 `complete=false`면 전체 최저가 또는 운행 없음으로 단정하지 않습니다.

각 구간에 `service`를 지정합니다. 연결 여정은 같은 서비스의 도착·출발 터미널 ID가 일치할 때 구성합니다. 시외·고속 터미널 사이의 도보 이동이나 환승 시간은 검증된 대응 정보가 없어 자동으로 연결하지 않습니다.

`get_payment_options({service: "intercity" | "express"})`로 운행편 선택 없이 본인의 GO 연결·결제 수단 상태를 조회할 수 있습니다. 이 입력은 로그인이 필요하며, `{tripRef}`와 동시에 전달할 수 없습니다.

`list_requests({})`는 `watches`와 `bookings`를 함께 반환합니다. 각각의 상태·최근 오류·예매 결과를 유지하며, 목록 조회만으로 감시나 결제를 실행하지 않습니다. `delivery: "inbox_only"`는 감시 알림의 전달 방식입니다.

`get_payment_options({tripRef})`는 결제 수단의 등록 여부와 이 서버의 실행 지원 여부를 구분합니다. 익명 호출에서는 공식 카드 결제 경로를 안내하고 Npay 자동결제는 `requires_account`로 표시합니다. 연결 후에는 본인 계정에서 확인한 `npayaut` 등록·사용·표시 상태로 Npay 이용 가능 여부를 판단합니다. GO에 등록된 다른 수단도 `executionSupported: false`일 수 있습니다. 등록되어 있다는 사실만으로 서버가 실행할 수 있는 결제가 되지는 않습니다. 계정·결제수단 조회에서 GO 인증이 만료되면 한 번 갱신하고 조회를 재시도합니다. 갱신 후에도 인증할 수 없으면 재연결을 안내합니다. `{tripRef}` 조회의 다른 계정 조회 실패는 `unknown`으로 표시하며, `{service}` 조회는 오류를 반환합니다. 결제 인증정보는 반환하지 않습니다.

`prepare_checkout`에는 `tripRef`, `maxFareKrw`와 `payment: {method: "official_card"}`를 반드시 전달합니다. 결과의 `executionMode: "user_checkout"`은 사용자가 시외 txbus 또는 고속 KOBUS 공식 사이트에서 직접 결제하는 경로를 뜻합니다. 고속 KOBUS 웹 결제는 PC용이며 `get_payment_options`는 웹 예매 가능한 편에도 `requires_desktop`을 반환합니다. `checkoutConstraints`에 기기 제한과 앱 이동의 범위를 제공합니다. 고속버스 링크는 자동 이동하지 않고 선택한 편과 이용 경로를 보여줍니다. 휴대폰에서는 티머니GO 앱 조회 화면을 열 수 있으며, 앱에 로그인되어 있을 때만 출발·도착 터미널을 전달합니다. 날짜·출발편·인원·좌석·결제수단은 앱에서 다시 선택해야 합니다. 2026-10-25 사용자 Android 기기에서 앱 실행과 서산→센트럴시티 터미널 전달을 확인했습니다. 이는 선택한 날짜·편·좌석이나 결제까지 전달된다는 뜻은 아닙니다.

고속버스에서 웹 예매가 허용되지 않은 편은 이 경로를 제공하지 않습니다. PC에서는 좌석을 다시 선택하고 본인인증·카드 입력·결제를 진행해야 합니다. GO에 저장된 카드나 자동예매에서 점유한 좌석을 재사용하지 않으며, 링크 준비·열기·앱 실행은 예매 확인이 아닙니다. 준비 시점의 요금 상한이 공식 사이트나 앱의 최종 결제액을 제한하지 않습니다. 시외버스 모바일 결제 지원 여부는 이번 고속버스 검증에 포함되지 않습니다.

## 자동예매와 연결 해제

새 예매 요청은 `version: 2`와 승객 구성·좌석 정책·결제·할인 정책을 반드시 받습니다. 성인·중고생·어린이 혼합 인원을 지원하며 승객별 좌석 구분, 점유 응답, 전체 결제 금액과 모든 표의 발권 결과를 대조합니다. `maxFareKrw`는 전체 승객의 최대 요금, `expiresAt`은 승인 종료 시각입니다. 같은 요청의 재호출에는 같은 UUID `idempotencyKey`를 사용합니다. 다른 조건에 같은 키를 재사용할 수 없습니다.

현재 결제 어댑터는 `payment: {method: "naver_pay_auto"}`, 추가 할인 정책은 `discounts: {mode: "none"}`을 지원합니다. 이 값들도 생략할 수 없습니다. `none`은 쿠폰·보훈·왕복 등 추가 할인 미적용을 뜻하며, 중고생·어린이의 제공자 요금은 승객 유형에 따라 적용합니다. 이 자동예매 어댑터는 다른 결제수단·추가 할인을 실행하지 않으며 지원하지 않는 값을 Npay나 일반 요금으로 바꾸지 않습니다. 공식 카드 결제는 앞서 설명한 사용자 직접 결제 경로로만 제공합니다. 계정 인증 어댑터는 토스 기존 회원 로그인이며 계정의 연령 코드를 성인으로 제한하지 않습니다. 새 회원 가입과 별도 인증수단은 제공하지 않습니다.

좌석 정책은 다음 중 하나를 명시합니다.

- `{"mode":"only","seats":[{"seat":11,"passengerType":"adult"},{"seat":12,"passengerType":"child"}]}`: 지정한 승객별 좌석만 허용합니다. 하나라도 없으면 다른 좌석으로 바꾸지 않습니다.
- `{"mode":"first_available","order":"descending","passengerOrder":["adult","child"]}`: 빈자리를 명시한 번호 순서로 골라 입력한 승객 순서에 배정하도록 승인합니다. `ascending`도 지원합니다.

`book_trip`은 `tripRef`, `passengers`, `seatPolicy`, `payment`, `discounts`, `maxFareKrw`, `expiresAt`, `intervalSeconds`, `idempotencyKey`, `version`을 받습니다. 선택한 운행편으로 즉시 한 번 시도하며 다른 편을 찾거나 빈자리가 날 때까지 기다리지 않습니다. 같은 키로 재호출하면 기존 결과를 반환합니다. 결과 미확인 상태의 조회 주기는 `intervalSeconds`를 사용합니다.

참조의 요금이 아직 확인되지 않았다면 좌석·요금 조회를 먼저 수행합니다. 선택한 모든 승객의 요금을 확인할 수 있을 때만 예매를 진행합니다. 고속버스 발권 확인은 계정·승객·좌석·운임·운행 등급·운송사·원래 출발시각을 대조하고, 예매 전 조회한 승차권 목록에 없던 새 승차권만 인정합니다. 예매 전 목록도 저장하므로 서버 재시작 후 같은 기준으로 결과를 확인합니다.

`create_booking_request`는 `tripRef` 대신 명시적인 `criteria`를 받아 조건을 감시합니다. 요청은 생성 당시 계정 연결에 묶이므로 같은 계정이라도 다시 연결하면 이전 요청의 결제를 이어 실행하지 않습니다. 이전 형식의 감시·예매 대기 요청은 `reauthorization_required`로 중단하며 새 선택에 동의한 것으로 바꾸지 않습니다. 이미 금융 처리가 시작된 이전 기록은 재결제하지 않고 확인 가능한 결과만 조회합니다.

서비스 구분을 추가하기 전의 정상적인 v2 기록은 시외버스로 읽고 기존 권한·중복 방지 키를 유지합니다. 서비스가 다른 요청에 같은 `idempotencyKey`를 사용하면 거절합니다. v1 기록에 새 자동결제 권한을 부여하지 않습니다.

조건에 맞는 편을 찾으면 먼저 본인의 Npay 자동결제 이용 가능 상태를 확인한 뒤 좌석을 점유합니다. 결제 준비 단계에서 Npay 상태를 다시 확인하고 결제 예약, 발권 시도, 결과 조회 순서로 진행합니다. `stage=booked`만 발권 확인이며 `held`나 `reserved`는 완료가 아닙니다. 응답 유실 등으로 결과가 불명확하면 `uncertain`으로 남기고 결과를 조회합니다. 이 상태를 새 요청으로 다시 결제하면 안 됩니다. Npay 등록 정보가 있다는 사실만으로 결제·발권 성공이 보장되지는 않습니다.

`cancel_booking_request`는 `watching` 상태의 승인만 중단합니다. 연결 해제는 GO 연결과 MCP 접근 권한을 무효화하고 중단 가능한 감시·자동예매 승인을 멈춥니다. **진행 중인 결제나 이미 발권된 승차권을 취소하지 않습니다.** 발권·취소 여부가 불명확하면 GO의 예매 내역에서 확인해야 합니다.

발권 승차권 취소는 별도의 `list_tickets` → `get_cancellation_quote` → `cancel_ticket` 순서로 요청합니다. 시외·고속의 일반 Npay 승차권에 대해 전체 또는 선택 좌석 취소를 지원하며, 다른 결제수단·복합결제·마일리지·쿠폰·왕복/결합 할인은 지원하지 않습니다. `ticketRef`와 `quoteRef`는 연결 계정에 귀속됩니다. 사용자에게 좌석·수수료·환불 예상액을 보여주고 승인받은 뒤 `quoteRef`, `acceptedFeeKrw`, UUID `idempotencyKey`를 전달합니다.

수수료는 제출 직전 다시 비교하지만 `preflight_only`입니다. 공급자 요청에 원자적 최대 수수료 보장은 없습니다. `cancelled`는 독립적으로 조회한 공급자 취소 내역 확인이며 Npay·은행 입금 완료를 뜻하지 않습니다. `uncertain`이면 새 키로 재시도하지 말고 `list_tickets`에서 상태를 확인합니다. 재시작 후에도 불확실한 요청은 조회로만 재확인하고 취소 요청을 자동 재전송하지 않습니다. 연결 해제는 제출 전 요청을 무효화하지만 이미 제출한 취소를 되돌리지 않습니다. 이 구현은 로컬 합성 응답으로 검증하며 실제 GO 취소·환불은 별도 검증 대상입니다.

## 감시와 운영 범위

감시·자동예매의 `intervalSeconds`는 필수입니다. `watch_trips`는 `notification: "on_transition" | "every_match"`와 `retryPolicy`도 받습니다. `{"mode":"fixed_interval"}`은 실패 후에도 지정한 간격을 유지하고, `{"mode":"exponential_backoff","maxIntervalSeconds":3600}`은 승인한 최대 간격 안에서 실패 시 간격을 늘립니다. 생략한 정책을 서버가 고르지 않습니다.

`booking_available`은 웹 예매 가능한 편을 찾는 조건이며 수신 기기의 결제 지원이나 정확한 판매 개시 시각을 증명하지 않습니다. 고속 KOBUS 웹 결제는 PC용입니다. 빈 결과만으로 미오픈·매진·운행 없음을 구분하지 않습니다.

운영자는 `MCP_LIMITS` JSON으로 계정 수, 사용자별 감시·예매 수, 보존량, 참조 유효시간, 검색량, 여정 구간 수, 감시 주기 범위와 작업 순회량을 설정합니다. 유효 설정은 `get_service_capabilities`가 반환합니다. 예: `MCP_LIMITS='{"accounts":50,"journeyLegs":4,"minimumPollSeconds":60,"tripReferenceTtlSeconds":600}'`. 선택 정책과 별개인 서버 자원 한도이며, 보안 검증이나 API 규격 상수를 사용자 입력으로 바꾸지 않습니다.

현재 구조는 **단일 Bun 프로세스와 SQLite 영속 디스크**를 전제로 합니다. 기본 운영값은 사용자 100명, 작업 묶음당 10명, 전체 순회 시작 간격 30초, 감시 주기 범위 5분~24시간, 참조 유효시간 15분입니다. 한 순회의 사용자들을 10명씩 순차 처리하며 묶음 사이에는 고정 대기를 넣지 않습니다. 순회 소요 시간은 다음 대기에서 빼고, 운영자가 허용한 최소 감시 간격이 더 짧으면 그 간격으로 순회합니다. 실제 조회 여부는 각 요청의 `intervalSeconds`와 종료 시각으로 결정합니다. 느린 외부 응답 때문에 확인이 늦어질 수 있으며 특정 감지 시간을 보장하지 않습니다. 프로세스가 꺼지면 감시도 멈추며 다중 인스턴스 분산 실행은 지원하지 않습니다.

운영 설정으로 더 짧은 감시 간격을 허용할 수 있지만, 공급자가 지원하는 초 단위 연속 조회 한도는 확인되지 않았습니다. 기본 최소 간격을 변경하지 않았으며, 로컬의 짧은 간격 검증은 실제 공급자 처리량을 증명하지 않습니다.

알림은 `check_alerts`에 `after`와 `limit`을 명시해 읽습니다. `nextCursor`를 다음 요청의 `after`에 전달하면 읽은 항목을 건너뜁니다. 사용자에게 보여 주거나 알리는 방식은 VOOY가 결정합니다. 이 서버가 VOOY 채팅으로 직접 메시지를 보내는 연동은 없습니다.

## 검증

Inspector에서 가상 계정으로 17개 도구를 직접 실행하려면 `bun run sandbox`를 사용합니다.
별도 주소 `http://127.0.0.1:8788/mcp`에서 실행되며 실제 계정·결제에 접근하지 않습니다.
전체 순서 자동 검증은 `bun run sandbox:check`이며, 입력 예제와 제한은
[로컬 테스트 안내](docs/sandbox.md)에 있습니다.

```sh
pnpm check
pnpm test
```

실제 HTTP MCP를 통해 시외 서울남부→서산과 고속 센트럴시티→서산의 공개 조회·좌석·요금·공식 결제 연결을 확인했습니다. 합성 계정과 로컬 HTTP·SQLite로 익명 조회, 보호된 호출의 OAuth 요구, 공개 참조의 로그인 후 재사용, 사용자 격리, 계정 재연결·해제, 시외·고속의 감시·예매 상태 전이와 불확실한 결제 결과 처리를 검증합니다. 관련 실행 기록은 `.omo/evidence/express-20261024/`에 있습니다. 2026-10-25 공개 HTTPS와 VOOY 공개 조회, Android GO 앱 전환, 모바일 토스 인증·GO 로그인·토큰 갱신, VOOY OAuth 왕복과 실제 요청 목록 조회를 확인했습니다. Npay 결제·발권은 아직 검증하지 않았습니다.
