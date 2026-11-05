# 로컬 MCP 샌드박스

실제 애플리케이션의 HTTP MCP 도구 17개를 합성 데이터로 실행합니다. 공급자 응답은 로컬 fixture로 대체하며 외부 공급자로 네트워크 요청을 보내지 않습니다. 임시 계정·DB를 만들고 종료할 때 삭제합니다. 실제 계정 연결, 좌석 점유, 결제, 발권, 환불은 발생하지 않습니다.

## 자동 실행 확인

```sh
bun run sandbox:check
```

별도 임시 서버를 열어 도구 17개를 순서대로 호출하고 종료합니다. `17/17 도구 성공`은 도구 목록과 호출 목록이 일치하고 각 응답의 예상 결과를 확인했다는 뜻입니다. 직접 예매는 `stage=booked`, 승차권 취소는 `stage=cancelled`, 감시는 알림 생성까지 검증합니다. 공식 결제 링크 준비는 `requires_user_checkout`를 확인합니다.

`/tmp/tmoney-sandbox-walkthrough.json`에 각 단계의 `name`, `arguments`, `result`가 저장됩니다. 다른 경로로 저장하려면 다음처럼 실행합니다.

```sh
bun run scripts/sandbox-walkthrough.ts /tmp/my-walkthrough.json
```

이 JSON은 **종료된 임시 서버의 실행 증거**입니다. UUID를 다른 서버에 그대로 복사하면 사용할 수 없습니다. 아래 수동 실행에서는 새 응답의 참조를 이어서 사용하세요.

## MCP Inspector에서 직접 호출

터미널 두 개에서 각각 실행합니다.

```sh
bun run sandbox
```

```sh
bunx @modelcontextprotocol/inspector
```

Inspector의 Transport를 **Streamable HTTP**, URL을 `http://127.0.0.1:8788/mcp`로 설정하고 연결합니다. 인증 헤더는 입력하지 않습니다. 이 로컬 서버만 임시 합성 계정으로 연결됩니다. **Tools → List Tools**에서 도구 17개를 확인합니다.

아래 순서로 호출하면 됩니다. 상세 JSON은 자동 실행 결과의 `arguments`를 참고하되, `tripRef`, `watchId`, `bookingId`, `ticketRef`, `quoteRef`는 현재 서버에서 받은 값으로 바꿉니다. 새로운 예매·취소 요청에는 새 UUID `idempotencyKey`를 사용하고 같은 요청을 재조회할 때는 원래 키를 유지합니다.

| 순서 | 도구 | 입력·확인 사항 |
| --- | --- | --- |
| 1 | `get_service_capabilities` | `{}`. 지원 기능 확인 |
| 2 | `search_terminals` | `{"service":"express","query":"센트럴"}` |
| 3 | `search_trips` | 아래 조회 JSON. 응답의 `tripRef` 보관 |
| 4 | `get_seats` | `{"tripRef":"현재 tripRef"}`. 합계 34,500원 |
| 5 | `get_payment_options` | `{"service":"express"}`. 합성 계정 연결 확인 |
| 6 | `find_journeys` | 자동 실행 JSON의 입력. 대안 1개 이상 |
| 7 | `prepare_checkout` | 현재 `tripRef`, `maxFareKrw:34500`, `payment:{"method":"official_card"}`. 링크 준비 상태 확인 |
| 8 | `watch_trips` | 자동 실행 JSON의 입력. 응답의 `watch.id` 보관 |
| 9 | `check_alerts` | `{"after":0,"limit":100}`. 해당 감시 알림 확인 |
| 10 | `cancel_watch` | `{"watchId":"현재 watch.id"}`. `cancelled:true` |
| 11 | `create_booking_request` | 자동 실행 JSON의 입력. 최대요금 1원으로 대기 요청 생성. `booking.id` 보관 |
| 12 | `cancel_booking_request` | `{"bookingId":"현재 booking.id"}`. `cancelled:true` |
| 13 | `book_trip` | 자동 실행 JSON의 입력에서 `tripRef`와 새 UUID 사용. `booking.stage:booked` |
| 14 | `list_requests` | `{}`. 예매 완료·요청 중단 상태 확인 |
| 15 | `list_tickets` | `{"service":"intercity"}`. 별도로 준비된 합성 승차권의 `ticketRef` 보관 |
| 16 | `get_cancellation_quote` | 현재 `ticketRef`, `selection:{"mode":"all"}`. `quoteRef`, `feeKrw` 보관 |
| 17 | `cancel_ticket` | 현재 `quoteRef`, `acceptedFeeKrw`에 응답의 `feeKrw`, 새 UUID. `cancellation.stage:cancelled` |

조회 입력:

```json
{
  "service": "express",
  "departureId": "021",
  "arrivalId": "393",
  "date": "2026-10-30",
  "time": "14:00",
  "passengers": { "adults": 1, "students": 1, "children": 1 }
}
```

샌드박스 시계는 실행할 때마다 2026-10-24 정오(KST)에서 시작해 실제 경과 시간만큼 흐릅니다. 날짜를 오늘 기준으로 변경하지 않아도 됩니다. 새 실습은 서버를 Ctrl+C로 종료한 뒤 다시 시작하면 초기 상태로 돌아갑니다. `tripRef` 등의 유효기간과 소유자 범위는 실제 도구와 동일하게 적용됩니다.

고속 예매와 시외 승차권 취소는 **서로 독립된 합성 시나리오**입니다. 방금 예매한 고속 승차권을 시외 취소 단계에서 취소하는 흐름은 아닙니다. 공식 결제 링크는 준비 결과만 살펴보세요. 이 샌드박스는 공식 결제 화면을 모사하지 않으며, 취소 완료 상태도 실제 은행 환불 입금의 증거가 아닙니다.
