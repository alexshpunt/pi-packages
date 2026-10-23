# pi-devin의 Effect v4 Layer 기반 재설계 근거

## 1. 설계 방향과 변경 범위

> **Layer 기반 기능 모듈화 + 쿼리 소유권·상태·수명 관리 전면 재설계**

`apps/pi-devin` 패키지 전체(공용 `src/core`, Pi 확장 `src/pi`, 개발용 CLI `src/cli`)의 내부 구조를 Effect v4의 서비스와 Layer 중심으로 다시 설계한다. 1차 전환(커밋 `eb95e1e`)은 내부 API를 Effect 값으로 바꾸었지만, 서비스 조립·쿼리 상태·실행 수명은 이전 구조를 그대로 옮겼다. 이번 전환은 목표 구조를 먼저 정하고 내부 구현을 그 구조로 교체한다.

보존 대상은 기존 코드의 형태가 아니라 **외부에서 관찰되는 기능과 동작 계약**이다.

| 구분 | 이번 전환의 기준 |
| --- | --- |
| 재설계 대상 | 디렉터리, 내부 API, 서비스 조립, 쿼리 상태의 소유자, 비동기 실행·취소·정리, core가 실행 환경을 받는 방식, 테스트 구성 |
| 유지 대상 | Pi 공급자·OAuth·도구·명령 계약, 저장 형식(세션 상태, 설정 파일, 공유 사용량 기록, 모델 저장소), 모델 ID·투영 정책, 요청 wire 형식, 실패·취소 의미, CLI 출력과 종료 코드 |
| 필수가 아닌 것 | 기존 내부 파일 경로, `createDevinProvider`·`createDevinAccountAuth` 같은 factory API, 공급자 객체의 부가 메서드, 임시 호환 facade |
| 도입하지 않는 것 | 기능을 선택적으로 빼는 builder, 기존·신규 실행 경로의 공존, 요청하지 않은 재시도·시간 제한·연결 공유 정책 |

기능별 서비스는 `Context.Service`로 정의하고 `Layer`로 조립한다. 쿼리별 상태와 자원은 명시적인 소유자 아래에 두고, 반환 후에도 계속되는 작업은 소유자의 `FiberSet`이나 `Scope`에 연결한다. 파일은 책임에 따라 나누되, 같은 쿼리의 상태를 독립적인 여러 소유자로 나누지 않는다.

Layer의 역할은 의존성 조립이다. 취소·늦은 완료·정리 순서의 안전성은 Layer가 자동으로 주지 않으며, 상태 소유권과 실행 경계를 설계해서 확보한다.

독자는 이 패키지의 유지보수자와 전환 담당자다. 1–8절은 전환 전 코드 분석과 설계 판단이다. 목표 트리의 파일명과 서비스명은 설계상의 구분이며 공개 API가 아니다. 실제 구현 대응과 검증 결과는 9절에 기록한다. Effect 도입만으로 기능 보존, 성능 향상, 자원 누수 제거가 입증되지는 않는다.

분석 대상은 패키지 `0.1.5`, 커밋 [`eb95e1e`][base-commit](1차 Effect 전환)이다. 코드 근거 링크는 이 커밋에 고정했다. Effect는 `4.0.5`, Node.js는 `24.14.0`에서 확인했다.

## 2. 전환 전 코드에서 확인한 사실

### 2.1 조립은 수동 순서와 지연 참조에 의존한다

[`createDevinProvider`][source-provider]는 Runs(`DevinLifecycle`), 수명 `Cancellation`, 클라이언트 등록부, 계정 기록부를 차례로 만든 뒤 인증 객체를 만든다. 인증 객체의 `onLogin` 콜백은 아직 선언되지 않은 모델 목록 `source`를 `Effect.suspend(() => source.invalidate)`로 참조한다. `source`는 그 아래에서 만들어진다.

```typescript
onLogin: Effect.all([
  accounts.clear, clients.clearFingerprints, Effect.suspend(() => source.invalidate),
  ...
]),
...
const source = Effect.runSync(createDevinModelSource({ ... }));
```

추론 함수에는 `{ auth, source, lifecycle, clients, accounts, lifetime: () => lifetime }` 객체를 넘긴다. `lifetime`이 getter인 이유는 `attachSession`이 수명을 새 값으로 바꾸기 때문이다. [확장 등록][source-extension]도 같은 방식이다. `onAccountUsage` 콜백은 함수 아래에서 선언되는 `provider`와 나중에 설정되는 `statusContext`를 참조한다.

이 구조가 현재 실패한다는 증거는 없다. 다만 "생성 중에는 콜백을 호출하지 않는다"는 관례를 아는 사람만 새 모듈을 안전하게 붙일 수 있고, 타입만으로 조립이 끝났는지 판단할 수 없다.

### 2.2 같은 쿼리를 여러 곳에서 보내고, 결과는 또 다른 곳에 둔다

| 쿼리 | 보내는 곳과 정책 | 결과 보관 |
| --- | --- | --- |
| 계정 상태 `GetUserStatus` | [요청 직전 확인][source-inference-probe]: 세대가 바뀌면 취소, 이미 아는 계정이면 일시적 연결 실패를 허용 · [로그인 직후][source-account-auth]: 15초 상한, 실패는 무시 · [세션 재확인][source-account-auth]: 이미 확인한 계정이면 생략, 인증 실패면 무효화 | [`AccountBook`][source-accounts]: 확인된 계정(최대 16), 최신 사용량, 공유 파일 |
| 모델 카탈로그 `GetCliModelConfigs` + 팀 설정 | [`provider.ts`의 `fetchCatalog`][source-provider]: 사용 가능 확인, 팀 정책 적용, 인증 실패 시 무효화 | [`models/source.ts`][source-model-source]: 투영, 목록, 범위, 확인 시각 · Pi 모델 저장소: 영속 사본 |

계정 상태는 세 경로가 각자 클라이언트를 열고, 기록 여부와 세대 비교를 각자 판단한다. 카탈로그는 "어떻게 가져오는가"(provider), "언제 다시 가져오는가와 무엇을 보여 주는가"(source), "디스크에 무엇을 남기는가"(Pi 저장소)가 세 곳에 나뉘어 있다. 인증 실패 판정 함수 `authenticationFailed`는 [추론 모듈][source-inference]에 있지만 카탈로그 조회도 이 함수를 쓴다.

### 2.3 무효화와 재로그인의 후속 처리는 콜백으로 퍼진다

| 사건 | 현재 후속 처리 (같은 동기 흐름) |
| --- | --- |
| 확인된 401 (같은 로그인 세대) | 무효 표시 → 계정 기록 삭제 → 진행 중 실행 중단 → 사용량 변경 알림 |
| 재로그인 성공 | 세대 증가 → 계정 기록·지문 캐시·모델 목록 비우기 → 진행 중 실행 중단 → 알림 → 새 세션 계정 확인 |

이 순서는 의미가 있다. 예를 들어 재로그인 뒤의 계정 확인이 모델 목록 비우기보다 먼저 끝나면, 새 계정의 기록이 바로 지워질 수 있다. 결합도를 낮춘다는 이유로 이 후속 처리를 비동기 이벤트 큐로 바꾸면 안 된다. 사건을 일으킨 소유자가 같은 Effect 안에서 순서대로 처리해야 한다.

### 2.4 Pi 호출, 실행(run), 세션, 공급자 수명은 서로 다른 단위다

| 단위 | 실제 역할 | 구분하지 않을 때 생기는 회귀 |
| --- | --- | --- |
| Pi 공급자 호출 (`streamSimple`) | 하나의 Devin 스트림 요청과 그 응답 이벤트 | 호출이 끝날 때 실행까지 닫으면 도구 후속 호출과 재시도가 새 예산을 받는다. |
| 실행 ([`DevinLifecycle`][source-lifecycle]의 execution) | 도구 후속·재시도·압축 복구를 포함해 `agent_settled`까지 같은 예산과 실행 ID | 다른 사건이 실행을 끝내면 진행 중 요청이 엉뚱한 사유로 취소된다. |
| Pi 세션 | cascade·trajectory ID, `pi-devin.state.v1` 기록, 세션별 사이드킥 자식 Pi | 세션 종료를 런타임 폐기로 처리하면 같은 인스턴스에 다시 들어오는 호출이 실패한다. |
| 공급자 수명 | `shutdown`부터 다음 `attachSession`까지 진행 중 작업을 멈추는 사유 | 수명을 다시 만들지 않으면 세션 전환 뒤 요청이 계속 취소된다. |

사이드킥 자식 Pi는 리드 세션 하나에 하나이며, 도구 호출보다 오래 산다. 실행 중인 handoff에 지시를 추가(steer)하고, 보고서는 차단 호출이나 백그라운드 전달 중 하나로 정확히 한 번 나간다.

### 2.5 소유자 없는 실행이 남아 있다

1차 전환 뒤에도 실행 경계가 아닌 곳에서 Effect를 즉석으로 실행한다.

| 위치 | 실행 | 문제 |
| --- | --- | --- |
| [추론 요청][source-inference] | `Effect.runFork(settled)` | 요청 Fiber의 소유자가 없다. 종료 시 멈추는 수단은 수명 `Cancellation`뿐이다. |
| [사이드킥 보고 전달][source-sidekick-tool] | `Effect.runFork`(백그라운드 전달, 완료 판정) | `reset` 뒤에도 Fiber가 남아 `canDeliver`로만 걸러진다. |
| [사이드킥 완료 처리][source-sidekick-runtime] | `Effect.runFork(this.complete(...))` | 자식 종료와 완료 처리의 소유 관계가 코드에 드러나지 않는다. |
| 계정 사용량, 모델 필터, `/devin` 예산 | `Effect.runSync` | 동기 호출 경로마다 실행 경계를 따로 만든다. |

### 2.6 core는 실행 환경을 옵션으로 받는다

[`makeConnectClient`][source-connect-client]는 `fetch`·`http` 옵션으로 전송을 고르고, [`makeDevinClient`][source-client]는 `fingerprint` 옵션을, [`loginAccount`][source-login]는 `fetch` 옵션을 받는다. [`createFingerprintProvider`][source-fingerprint]는 기기 수집 결과를 캐시하려고 생성 시점에 `Effect.runSync`를 실행한다. 소비자(Pi, CLI, 테스트)가 호출마다 옵션을 골라 넘기는 구조다.

Connect 클라이언트마다 자기 keep-alive 연결 풀을 갖는 것은 Effect 이전부터의 동작이다([`transport.ts`][source-main-transport]). 클라이언트를 닫으면 그 연결만 끊기고, 서로 다른 클라이언트의 요청은 연결을 공유하지 않는다. 전송을 서비스로 옮겨도 이 단위는 유지해야 한다.

### 2.7 Pi가 동기로 부르는 경계가 있다

`getModels`, `filterModels`, `getFusionChoices`, 상태 표시줄 갱신은 동기 호출이다. `streamSimple`은 스트림을 동기로 반환한다. 이벤트 핸들러는 동기로 실행되고, `session_start`의 공급자 ID 충돌은 동기 예외로 알린다. 설정 파일은 TUI 그리기 같은 동기 콜백에서 읽는다.

Effect 4.0.5의 `ManagedRuntime.runSync`는 Layer 생성과 실행할 Effect가 모두 동기일 때만 성공한다. Node 파일·프로세스 Layer를 포함한 조립이 동기로 만들어지고 `runSync`가 동작함을 실험으로 확인했다. `FiberSet.run(..., { startImmediately: true })`는 포크한 Fiber의 동기 구간을 반환 전에 실행한다.

## 3. 목표 구조와 책임

아래는 목표 구조의 대표 파일이다. 계약·정책·상태 전이·외부 연동을 구분한다. 순수 함수마다 서비스나 Layer를 만들지는 않는다.

```text
apps/pi-devin/
├── index.ts                       # Pi 진입점: 환경 변수 검증, 운영 Layer 선택, 등록
├── cli.ts                         # CLI 진입점
└── src/
    ├── core/                      # Pi·CLI 공용 Devin 프로토콜 (계약 버전 3)
    │   ├── services/
    │   │   ├── http-transport.ts  # HttpTransport: 호출 Scope마다 연결 풀을 여는 전송
    │   │   ├── device-identity.ts # DeviceIdentitySource: 기기 식별값 수집
    │   │   └── platform.ts        # Node 파일·프로세스 Layer, commandOutput
    │   ├── protocol/              # Connect·REST, 프레임, protobuf, 지문
    │   ├── client.ts              # makeDevinClient: 서비스에서 전송·기기 수집을 받음
    │   ├── auth/                  # 로그인(PKCE·콜백·코드 교환), 권한 판정
    │   ├── models/                # 카탈로그 해석·변형 투영 (순수)
    │   └── inference/             # 요청 구성·응답 누적·재시도 정책 (순수 중심)
    ├── pi/
    │   ├── app/
    │   │   ├── config.ts          # ExtensionConfig: 진입점이 정한 값
    │   │   ├── environment.ts     # 운영 환경 Layer
    │   │   ├── layer.ts           # ProviderLive·ExtensionLive 조립
    │   │   ├── runtime.ts         # 확장 인스턴스별 ManagedRuntime
    │   │   └── session.ts         # 세션 연결·종료의 서비스 간 순서
    │   ├── features/
    │   │   ├── lifetime/          # ProviderLifetime
    │   │   ├── auth/              # AuthState · CredentialGuard · AccountLogin
    │   │   ├── clients/           # DevinClients
    │   │   ├── accounts/          # Accounts: 계정 상태 쿼리의 단일 소유자
    │   │   ├── catalog/           # ModelCatalog: 카탈로그 쿼리의 단일 소유자
    │   │   ├── runs/              # Runs: 실행·예산·lease·세션 상태
    │   │   ├── inference/         # Inference: 요청별 Scope·Fiber
    │   │   ├── usage/             # UsageChanges, 사용량 표시 계산
    │   │   ├── settings/          # 설정·사용량 저장소 계약과 메모리 구현
    │   │   └── sidekick/          # Sidekicks · SidekickChild · SidekickLauncher
    │   └── adapters/
    │       ├── pi/                # 공급자 객체·OAuth·응답 스트림·기록 변환·도구·명령·이벤트·TUI
    │       └── storage/           # JSON 파일 읽기·원자적 쓰기, 파일 저장소 Layer
    └── cli/                       # 개발용 CLI (배포 제외)
        ├── app/                   # CLI Layer와 명령 분기
        ├── services/              # 출력, 상태 파일, 로그인 UI
        └── commands/              # 로그인·조회·대화·검증 명령
```

### 3.1 조립·진입·기능의 책임

| 소유자 | 맡는 책임 | 맡지 않는 책임 |
| --- | --- | --- |
| `app/layer.ts` | 기능 서비스와 외부 어댑터의 의존성 연결 | 요청 실행, 상태 변경 |
| `app/runtime.ts` | 인스턴스 실행 환경 생성. 세션 종료로 폐기하지 않음 | 공급자 수명 사유, 모델 정책 |
| `app/session.ts` | 세션 연결(수명 갱신 → 실행 상태 복원)과 종료(수명 종료 → 실행 종료 → 클라이언트 닫기 → 기록 비우기)의 순서 | 각 서비스 내부 상태의 직접 변경 |
| `features/*` | 소유한 쿼리·상태의 조회, 전이, 후속 처리 | Pi 객체 생성, 다른 서비스 내부 Map 변경 |
| `adapters/pi` | Pi 계약의 동기 반환·Promise·이벤트를 서비스 호출로 변환 | 계정·카탈로그 정책 결정 |
| `adapters/storage` | 파일 읽기·원자적 저장, 파일 저장소 Layer | 설정값의 의미 해석 |
| `core/services` | 외부 I/O의 계약과 Node 구현 | Pi·CLI 정책 |

### 3.2 서비스 의존성은 한 방향으로 조립한다

```text
Pi 어댑터 (공급자 객체 · OAuth · 등록 · 명령)
  ├─ Inference ─→ AuthState, CredentialGuard, ModelCatalog, Accounts, DevinClients, Runs, ProviderLifetime
  ├─ AccountLogin ─→ AuthState, Accounts, CredentialGuard, ModelCatalog, DevinClients, Runs, UsageChanges, ProviderLifetime
  ├─ ModelCatalog ─→ AuthState, CredentialGuard, Accounts, DevinClients, 설정 저장소, UsageChanges, ProviderLifetime
  ├─ CredentialGuard ─→ AuthState, Accounts, Runs, UsageChanges
  ├─ Accounts ─→ AuthState, DevinClients, UsageStore, UsageChanges, ProviderLifetime
  ├─ DevinClients ─→ core HttpTransport, DeviceIdentitySource
  └─ Sidekicks ─→ SidekickHost, SidekickLauncher, ModelCatalog
```

권장 규칙은 다음과 같다.

1. 서비스 메서드가 반환하는 Effect는 추가 요구 서비스가 없다(`R = never`). 의존성은 Layer를 만들 때 한 번 받는다.
2. 역방향 의존을 만들지 않는다. AuthState, Runs, ProviderLifetime, UsageChanges는 다른 기능 서비스를 요구하지 않는 상태 소유자다.
3. 후속 처리는 사건을 일으킨 소유자가 같은 Effect 안에서 순서대로 호출한다. 재로그인은 AccountLogin이, 인증 실패 무효화는 CredentialGuard가 맡는다.
4. 상태 표시줄처럼 사용량 변경을 듣는 쪽은 UsageChanges를 구독한다. 구독은 동기로 호출되며 실패는 요청에 영향을 주지 않는다.
5. 모든 서비스를 하나의 객체로 전달하는 방식은 없앤다. 서비스가 요구하는 기능과 바꿀 수 있는 상태를 계약에 드러낸다.

### 3.3 Pi 동기 경계는 런타임의 동기 실행으로 연결한다

확장 인스턴스를 등록할 때 Layer를 한 번 동기로 만든다. 이때 실패(예: 잘못된 예산 값)는 등록 함수의 동기 예외가 된다.

| Pi 경계 | 연결 방식 |
| --- | --- |
| `getModels`, `filterModels`, 이벤트 핸들러, 상태 표시줄 | `runtime.runSync` (동기 Effect만 사용) |
| `streamSimple` | `runtime.runSync(inference.start(...))`: 응답 스트림을 만들고 요청 Fiber를 서비스의 `FiberSet`에 `startImmediately`로 붙인 뒤 스트림을 반환 |
| OAuth `login`·`refresh`·`toAuth`, `refreshModels`, 명령, 도구 실행 | `runtime.runPromise`. 호출자의 `AbortSignal`과 공급자 수명은 서비스 안에서 처리 |

이벤트 처리는 서비스 작업이 끝난 뒤 반환한다. 비동기 큐에 넣고 바로 반환하지 않는다.

## 4. 쿼리 소유권과 수명

### 4.1 쿼리마다 소유자는 하나다

| 쿼리·작업 | 단일 소유자 | 소유 상태 | 수명과 정리 |
| --- | --- | --- | --- |
| 자격 증명 유효성 | AuthState | 로그인 세대, 무효 자격 증명(최대 64), OAuth 세션(최대 64) | 인스턴스 |
| 계정 상태 | Accounts | 확인된 계정(최대 16), 최신 사용량, 공유 사용량 파일 기록 | 조회 클라이언트는 `check` 호출의 Scope. 기록은 공급자 수명 동안만 |
| 카탈로그 | ModelCatalog | 투영, 모델 목록, 카탈로그 범위, 확인 시각, 엔드포인트 재정의, 마지막 자격 증명 범위 | `refresh` 호출을 공급자 수명과 Pi 신호로 멈춤. 상태는 Pi가 publish를 수락할 때만 바뀜 |
| 클라이언트 | DevinClients | 범위별 지문(최대 16), 열린 클라이언트 | 클라이언트는 연 쪽의 Scope와 함께 닫힘. `closeAll`은 공급자 종료 때만 |
| 실행 | Runs | 실행 데이터, 예산, 입장 순서, 정리 작업, 세션 상태 기록 | `finish`·`abort(사유)`·`shutdown` |
| 추론 요청 | Inference | 응답 스트림, 누적기, 실제 UID | 요청별 Scope(lease, 요청 클라이언트)와 확인 직후 닫히는 계정 확인 Scope. Fiber는 서비스의 `FiberSet` |
| 로그인 | AccountLogin | 없음(AuthState·Accounts에 위임) | Pi Promise 호출. 호출 시작 시점의 공급자 수명과 Pi 신호 |
| 사이드킥 | Sidekicks, SidekickChild | 세션별 자식 Pi, 진행 중 handoff, RPC 대기, 보고 전달 기록, 진행 표시 대상 | 자식 Pi는 세션 단위. 전달·완료 판정 Fiber는 Sidekicks의 `FiberSet` |

계정 상태의 세 경로는 `Accounts.check` 하나로 모은다. 호출자는 기대하는 로그인 세대와 연결 옵션, 기록 직전 확인을 넘긴다. `check`는 세대가 바뀌었으면 기록하지 않고 `"stale"`을 반환한다. 세대 변경을 취소로 볼지(요청 직전 확인), 조용히 넘어갈지(로그인 직후, 재확인)는 호출자가 정한다. 실패 정책(일시적 연결 실패 허용, 무효화 여부)도 호출자에 남긴다. 정책을 한곳으로 합치면 경로별 실패 의미가 바뀌기 때문이다.

카탈로그는 조회, 팀 정책 적용, 인증 실패 무효화, 신선도 판단, 복원, 투영을 ModelCatalog가 모두 소유한다. Pi 모델 저장소는 여전히 영속 사본의 주인이며, 상태 변경은 `context.publish`가 수락한 `update` 안에서만 일어난다.

### 4.2 Scope는 정리 시점을 주지만 순서를 대신 정하지 않는다

추론 요청의 종료 순서는 그대로 유지한다.

```text
실패 또는 중단 (호출자 신호, 공급자 수명, 실행 중단, RPC 마감)
    → 확인된 인증 실패면 같은 세대에서 무효화
    → Pi 스트림에 최종 이벤트 하나 발행 (중단 사유로 aborted/error 구분)
    → 요청 Scope 정리: 요청 클라이언트 닫기, lease 해제(다음 요청 입장)
```

계정 확인 클라이언트는 자기 Scope를 따로 가지며 확인이 끝나는 즉시 닫힌다.

요청 Scope가 실패 보고까지 감싸므로, Pi는 클라이언트가 닫히고 다음 요청이 들어오기 전에 최종 이벤트를 받는다. 결함(defect)을 포함한 모든 종료는 정확히 하나의 최종 이벤트로 끝난다. 중단만 있는 원인은 `Cancelled`로 바꾼다.

공급자 종료의 순서도 유지한다.

```text
상태 표시 대상 해제 → 사이드킥 정리 → 공급자 수명 종료(사유: The Devin provider shut down.)
    → 실행 종료 → 열린 클라이언트 닫기 → 지문 캐시·계정 기록 비우기
```

수명 종료가 먼저 사유를 남기므로, 진행 중 요청은 Fiber 중단이 아니라 그 사유로 끝난다. Fiber를 먼저 중단하면 사유가 사라져 오류 문구가 바뀐다.

### 4.3 런타임은 확장 인스턴스에 두고 세션 종료와 구분한다

`ManagedRuntime`은 확장 인스턴스마다 하나 만들고 `session_shutdown`에서 폐기하지 않는다. 이유는 다음과 같다.

- 종료 뒤에도 Pi가 같은 공급자 객체의 `toAuth`를 부를 수 있다. 1차 전환에서 이 경로를 보존했다.
- 같은 인스턴스에 `session_start`가 다시 오면 공급자 수명을 새로 만들고 계속 쓴다.
- 인스턴스 수준 Layer에는 운영체제 자원이 없다. 연결 풀은 클라이언트 Scope에, 자식 Pi는 세션 정리에 묶인다. 남는 것은 메모리 상태와 비어 있는 `FiberSet`뿐이다.

공급자 수명은 런타임과 별개의 `ProviderLifetime` 서비스가 관리한다. 종료는 사유와 함께 현재 수명을 끝내고, 다음 세션 연결이 새 수명을 만든다.

## 5. Layer가 다른 조립 방식보다 적합한 이유

평가 기준은 다음 네 가지다.

1. 필요한 서비스와 초기화 관계를 타입으로 드러내는가.
2. 쿼리별 자원과 취소를 같은 실행 모델로 관리하는가.
3. 테스트에서 전송·기기 수집·저장소·자식 프로세스를 바꾸려고 운영 코드를 바꾸지 않아도 되는가.
4. 존재하지 않는 기능 조합이나 플러그인 체계를 추가하지 않는가.

| 대안 | 얻는 점 | 남는 비용 또는 문제 | 판단 |
| --- | --- | --- | --- |
| 현재 factory 유지, 명시적 인자 정리 | 의존성 추가 없음 | 지연 참조와 콜백 퍼짐, 소유자 없는 실행이 남는다. | 이번 목표에 맞지 않는다. |
| 기능 서비스 + Layer + 소유자별 Scope·FiberSet | 조립·실행·정리를 같은 모델로 다룬다. | 내부 API와 테스트 구성을 재편하고 동작 보존을 검증해야 한다. | 권장안 |
| Effect + 조립·수명까지 맡는 자체 builder | 구성 조합을 별도 문법으로 표현 | 사용자가 고르는 실행 구성이 없는데 별도 API를 유지해야 한다. | 근거가 없다. |
| 기존 코드를 큰 Effect 하나로 감싸기 | 변경이 적다. | 내부 상태와 실행 소유권은 그대로 남는다. | 목표를 충족하지 못한다. |

사이드킥 자식 Pi(`isFusionChild`)는 Fusion 항목·도구·명령·상태 표시를 등록하지 않는다. 이것은 기존 동작이며, 같은 Layer 구성 안에서 설정값으로 판단한다. 기능을 빼는 별도 조립 제품으로 만들지 않는다.

`ProviderLive`(Pi 공급자 계약에 필요한 기능)와 `ExtensionLive`(Pi 호스트가 필요한 사이드킥·상태 표시를 더한 구성)는 두 층이다. 공급자만 필요한 테스트와 SDK 사용은 `ProviderLive`를 쓴다. 이것은 기능 선택이 아니라 Pi 호스트 API 유무에 따른 층 구분이다.

## 6. Effect 적용 범위와 실행 계약

### 6.1 core는 실행 환경을 서비스로 받는다

| 대상 | 목표 구조 | 이유 |
| --- | --- | --- |
| HTTP 전송 | `HttpTransport` 서비스. `open`이 호출 Scope 동안 쓰는 `HttpClient`를 연다. Node Layer와 주입 fetch Layer | 클라이언트별 연결 풀을 유지하면서 소비자가 옵션을 넘기지 않게 한다. 요청마다 다른 fetch는 그 호출에만 서비스를 바꿔 제공한다. |
| 기기 식별값 | `DeviceIdentitySource` 서비스. Node Layer는 프로세스 실행 서비스를 컨텍스트에서 받는다 | 테스트가 운영 코드를 바꾸지 않고 수집 결과를 바꾼다. 수집 결과 캐시는 지문 제공자 단위로 유지한다. |
| 지문 제공자 | `makeFingerprintProvider`가 Effect로 생성 | 생성 시점의 즉석 `runSync`를 없앤다. |
| 클라이언트·로그인 | `makeDevinClient`, `makeConnectClient`, `loginAccount`가 위 서비스를 요구 | `fetch`·`http` 옵션 전달을 없앤다. |
| 모델 투영·요청 구성·응답 누적·재시도 계산 | 일반 함수 또는 Effect 반환 함수 그대로 | 외부 자원이 없는 계산에 서비스를 강제하지 않는다. |

core 계약이 바뀌므로 `CORE_CONTRACT_VERSION`을 3으로 올린다.

### 6.2 실행 경계

Effect를 실행하는 곳은 Pi 어댑터, CLI 진입점, 그리고 Node 콜백을 받는 어댑터(사이드킥 자식 프로세스 이벤트)로 제한한다. Node 콜백에서 시작하는 작업은 `FiberSet.runtime`으로 소유 서비스의 `FiberSet`에 붙인다. 기능 서비스 안에서는 `Effect.runFork`·`runSync`·`runPromise`를 쓰지 않는다.

### 6.3 오류의 원인과 외부 표현을 구분한다

외부 Promise는 항상 `{ try, catch }` 형태로 감싸 `DevinFailure`로 바꾼다. Effect의 기본 `UnknownError` 래핑을 사용자에게 노출하지 않는다. Promise 경계는 원래 오류 객체로 거부되므로, Pi와 CLI가 보는 `name`(`AbortError`, `TimeoutError`)과 메시지는 그대로다.

| 원인 | 보존할 결과 |
| --- | --- |
| 호출자의 취소 신호 | `aborted`, 신호의 사유와 이름 |
| 공급자 종료, 실행 종료, 재로그인 | 각 사유 문구를 가진 `Cancelled` |
| RPC 마감 | `TimeoutError`, 마감 시간 문구 |
| 일시적 연결 실패 | `Connection error (…)` 문구로 Pi 재시도 대상 |
| 확인된 401 | 같은 세대에서만 무효화, 로그인 안내 문구 |

## 7. 구조 변경으로 바꾸면 안 되는 동작

| 경계 | 보존해야 할 동작 |
| --- | --- |
| Pi 공급자 | ID·이름, 동기 `getModels`·`filterModels`·스트림 반환, 응답 이벤트 순서와 최종 이벤트 하나, usage·오류 표현, 공급자 ID 충돌 시 동기 예외 |
| 인증 | OAuth 세션만 허용, 하루 단위 재확인, 확인된 계정은 잠금 안에서 네트워크 생략, 세대별 무효화, 로그인 직후 15초 상한의 계정 확인과 실패 무시, 종료 뒤 `toAuth` |
| 추론 | 요청 직전 계정 확인과 일시적 실패 허용, 실행 예산과 입장 순서, 훅 순서와 식별자 보호, 캐시 보존 기간 판정, 클라이언트·lease 정리 순서 |
| 카탈로그 | 자격 증명·엔드포인트 범위, 저장 사본의 검증·복원 규칙, 5분 신선도, 일시적 실패 시 마지막 정상 목록 유지, 계정 전환 시 이전 목록 비노출 |
| 사이드킥 | 세션별 자식 Pi, steer, `block: false`와 사용자 입력에 의한 백그라운드 전환, 보고 한 번 전달, 보고 크기 제한과 보존 파일 |
| 설정·파일 | schemaVersion 1, 원자적 저장, 읽기 실패 시 기본값과 파일 무수정, 공유 사용량의 최신값 우선 |
| core | wire 형식, 압축 대체 재전송, 클라이언트별 연결 풀, RPC 마감, 401 처리, 비밀값 제거 |
| CLI | 명령과 옵션 검증 문구, JSON Lines 이벤트, 종료 코드, 보고서 저장, 세션 잠금과 저장 형식, 자격 증명 파일 형식 |

다음 변경은 리팩터링에 자동으로 포함하지 않는다.

- 클라이언트 간 연결 풀 공유. 서버가 보는 연결 수와 종료 시 끊기는 범위가 바뀐다.
- 재로그인 뒤 기기 식별값 재수집 방식 변경. 지문 제공자 단위 캐시를 유지한다.
- 무효화·재로그인 후속 처리의 비동기 전달.
- 재시도, 시간 제한, 동시 실행 제한의 추가나 변경.
- Schema 적용을 이유로 허용 입력이나 설정 처리 방식을 바꾸는 것.

## 8. 비용, 테스트 재구성, 검증 한계

### 8.1 테스트는 내부 접점을 바꾸되 기대 동작은 유지한다

기존 테스트는 `createDevinProvider`, `createDevinAccountAuth`, `provider.lifecycle` 같은 내부 접점과 `fetch`·`fingerprint` 옵션을 쓴다. 전환 후에는 테스트용 Layer(주입 fetch 전송, 고정 기기 수집, 메모리 저장소, 가짜 자식 프로세스 실행기)로 같은 상황을 만들고, 기존 기대 결과를 검사한다.

- 내부 접점 교체: 같은 입력·상황과 기대 결과를 새 구조에서 검사한다.
- 동작 변경: 기존 기대 결과나 순서를 바꾼다. 이는 기능 보존 리팩터링으로 간주하지 않으며, 생기면 따로 보고한다.

운영 구성에 존재하지 않던 조합을 검사하던 테스트(예: 계정 관찰자 없이 만든 인증 객체)는 서비스 대체 Layer로 같은 조합을 만든다. 운영 코드에 그 조합을 위한 분기를 추가하지 않는다.

### 8.2 비용과 이점

비용에는 Effect 서비스·Layer·FiberSet 이해, 내부 API 전면 교체, 테스트 재구성, 설치 패키지 검증이 포함된다. 기대하는 이점은 의존성을 드러내고, 상태 변경 권한과 정리 책임을 소유자에게 묶는 것이다. 유지보수 시간, 결함 수, 시작 시간, 메모리 사용량이 실제로 나아졌다는 측정 결과는 없다.

### 8.3 기준선

1차 전환 커밋 `eb95e1e`에서 `apps/pi-devin`의 `pnpm typecheck`와 `npx vitest run`이 통과했다(31개 파일, 237개 테스트). 배포본 검사(`validate-package.mjs --pack`, `--runtime`)와 import 범위 검사도 통과했다.

### 8.4 설계 시점에 남겨 둔 검증 사항

- 실제 Devin 서비스에서의 로그인·추론·사이드킥 동작
- 설치본을 새 프로젝트에 설치한 뒤의 로딩과 최소 Node.js 22.19.0에서의 실행
- 처리 지연, 메모리 사용량, 반복 종료·재진입에서의 자원 정리

## 9. 구현 대응과 검증 결과

### 9.1 설계 요소와 구현 위치

| 설계 요소 | 구현 |
| --- | --- |
| core 실행 환경 서비스 | `src/core/services/http-transport.ts`(`HttpTransport`, `NodeHttpTransport`, `FetchHttpTransport`), `device-identity.ts`(`DeviceIdentitySource`, `NodeDeviceIdentitySource`), `platform.ts`. `CORE_CONTRACT_VERSION = 3` |
| core 클라이언트·로그인 | `makeConnectClient`, `makeDevinClient`, `exchangeBrowserCode`, `loginAccount`, `login`이 `HttpTransport`(클라이언트는 `DeviceIdentitySource`도)를 요구한다. `makeFingerprintProvider`는 Effect를 반환한다. `makeHttpClient`와 `fetch`·`http` 옵션은 없앴다. |
| 조립 | `src/pi/app/layer.ts`의 `ProviderLive`·`ExtensionLive`, `runtime.ts`의 `makeProviderRuntime`·`makeExtensionRuntime`, `environment.ts`의 `productionEnvironment`, `config.ts`의 `ExtensionConfig` |
| 세션 연결·종료 순서 | `src/pi/app/session.ts`의 `attachSession`, `shutdownProvider`. 상태 표시 해제와 사이드킥 정리는 `adapters/pi/registration.ts`의 `session_shutdown`에서 그 앞에 실행한다. |
| 상태 소유자 | `features/lifetime`(`ProviderLifetime`), `features/auth/state.ts`(`AuthState`), `features/usage/changes.ts`(`UsageChanges`), `features/runs/service.ts`(`Runs`, 내부는 `DevinLifecycle`) |
| 쿼리 소유자 | 계정 상태: `features/accounts/service.ts`(`Accounts.check`). 카탈로그: `features/catalog/service.ts`(`ModelCatalog`) |
| 기능 | `CredentialGuard`(`features/auth/guard.ts`), `AccountLogin`(`features/auth/login.ts`), `DevinClients`(`features/clients`), `Inference`(`features/inference`), `Sidekicks`·`SidekickChild`·`SidekickLauncher`(`features/sidekick`) |
| 기본 스케줄러 | `features/default-scheduler.ts`의 `onDefaultScheduler`: 동기 Pi 호출보다 오래 사는 작업을 Effect 기본 스케줄러에서 실행한다(9.4절). |
| Pi 어댑터 | `adapters/pi/provider.ts`(`makeDevinProvider`), `oauth.ts`, `registration.ts`(`registerDevinExtension`), `response-stream.ts`, `transcript.ts`, `sidekick-tool.ts`, `usage-status.ts`, `devin-command.ts`, `fusion-command.ts`, `ui/` |
| 저장소 어댑터 | `adapters/storage/json-file.ts`, `files.ts`(Fusion·표시 설정, 공유 사용량 파일 Layer) |
| CLI | `src/cli/layer.ts`(`CLILive`), `services/`(`CLIOutput`, `StateFiles`, `SessionStore`, `LoginUI`), `commands/`(`login`, `chat`, `check`, `run`) |

3절의 목표 트리와 다른 점은 다음과 같다.

- **`RemoteCatalog` 서비스를 추가했다.** 카탈로그와 팀 설정을 한 번 조회하는 원격 쪽만 맡고 상태가 없다. 언제 조회할지, 무엇을 보여 줄지, 인증 실패를 무효화로 넘길지는 여전히 `ModelCatalog`가 정한다. 그래서 `ModelCatalog`는 `DevinClients` 대신 `RemoteCatalog`를 요구한다. 카탈로그 소유자를 대체 Layer로 단독 검사하려고 분리했다.
- **`LoginTransport` 서비스를 추가했다.** 로그인 코드 교환이 쓰는 전송이다. 운영에서는 Node 전송이고, 테스트는 로그인 교환만 다른 fetch로 바꾼다.
- **상태 표시줄은 `UsageStatus` 서비스**(`adapters/pi/usage-status.ts`)다. Pi UI 대상을 다루므로 기능이 아니라 어댑터에 두고 `ExtensionLive`에 넣었다.
- **CLI는 `cli/app/` 디렉터리 대신 `src/cli/layer.ts`와 `main.ts`로 두었다.** 파일 두 개라 디렉터리를 만들 이유가 없었다.
- **`R = never` 규칙의 예외는 두 개다.** `DevinClients.open`과 `UsageChanges.subscribe`는 호출자의 `Scope`를 요구한다. 클라이언트와 구독을 호출자의 Scope와 함께 정리하기 위한 의도된 예외다.
- **`types.ts`는 기능 디렉터리마다와 `adapters/pi`에 둔다.** `app/`, `adapters/storage/`, `core/services/`는 계약이 서비스 태그 옆에 하나뿐이라 따로 두지 않았다.

서비스 의존성은 3.2절과 같다. 위 추가 서비스와 `ExtensionConfig`·설정 저장소·`FileSystem` 같은 환경 서비스만 더해졌고, 역방향 의존은 없다.

### 9.2 실행 경계와 소유권

- `src/pi/features`, `src/pi/app`, `src/core`에는 `Effect.runSync`·`runFork`·`runPromise` 호출이 없다(구현 후 검색으로 확인).
- Effect를 실행하는 곳은 Pi 어댑터(`provider.ts`, `oauth.ts`, `registration.ts`, `sidekick-tool.ts`, `devin-command.ts`, `fusion-command.ts`, `ui/devin-panel.ts`), `index.ts`의 환경 변수 검증, CLI의 `main.ts`다.
- 추론 요청 Fiber는 `Inference`의 `FiberSet`에, 백그라운드 보고 전달과 완료 판정 Fiber는 `Sidekicks`의 `FiberSet`에 붙는다. 자식 Pi 프로세스 이벤트에서 시작하는 완료 처리는 `FiberSet.runtime`으로 같은 `FiberSet`에 붙인다.
- `runSync` 안에서 포크한 Fiber는 `runSync`의 동기 스케줄러를 물려받는다. 레이어를 `runSync`에서 만들 때 잡아 둔 `FiberSet.runtime` 실행기도 마찬가지다. 그래서 추론 요청과 자식 Pi 이벤트 처리는 `onDefaultScheduler`로 감싸 기준선의 `Effect.runFork`와 같은 기본 스케줄러에서 실행한다. `runtime.runPromise`로 실행하는 작업은 원래 기본 스케줄러를 쓴다.
- 계정 상태 조회 세 경로(요청 직전, 로그인 직후, 세션 재확인)는 모두 `Accounts.check`를 부른다. 세대가 바뀌면 `"stale"`을 돌려주고, 실패를 어떻게 다룰지는 각 호출자가 정한다.

### 9.3 테스트 재구성

테스트는 `tests/extension-harness.ts`의 대체 Layer로 상황을 만든다. 주입 fetch 전송, 고정 기기 수집, 메모리 저장소, 가짜 자식 프로세스 실행기, 연결 풀 수를 세는 전송(`countingTransport`)이 있다. 카탈로그 소유자(`makeTestCatalog`)와 사이드킥 도구(`makeTestSidekickTool`)는 주변 서비스를 대체해 단독으로 검사한다. CLI 전용 도우미는 `tests/cli-helpers.ts`로 분리했다. 공급자 테스트는 배포본을 대상으로도 실행하는데, 배포본에는 CLI가 없기 때문이다. 하네스는 운영 런타임 팩토리(`makeProviderRuntime`)와 운영의 현재 사용량 선택 함수(`currentAccountUsage`)를 그대로 쓴다.

기준선 237개 테스트는 하나도 빠지지 않았다. 이름, 내부 접근, 기대값이 바뀐 테스트는 다음과 같다.

| 구분 | 내용 |
| --- | --- |
| 이름 변경 | `sidekick-runtime.test.ts` 7개: 클래스 이름을 따라 `SidekickRuntime:` → `SidekickChild:`. `pi-auth.test.ts` 2개: 없어진 선택 사항을 가리키던 "with an account observer," 접두어 제거 |
| 내부 접근 변경 | `pi-integration`의 `/devin` 갱신 실패 테스트는 실제 카탈로그로 실행한다. 재구성이 정확히 한 번인지는 카탈로그가 목록을 만들 때마다 한 번 읽는 Fusion 설정 저장소의 읽기 횟수로 확인한다. `pi-lifecycle`의 `PI_DEVIN_MAX_MODEL_CALLS` 테스트는 예산을 `/devin` 출력("0/40", "0/8")에서 읽고, `session_shutdown` 핸들러로 종료한다. |
| 기대값 변경 | `pi-auth.test.ts`, `pi-auth-storage.test.ts` (아래 설명) |

**인증 테스트의 기대값 변경.** 기준선 테스트는 계정 관찰자(`onValidated`·`isAccountChecked`) 없이 만든 인증 객체를 썼다. 이 조합은 운영에 없었다. 기준선의 운영 조립(`createDevinProvider`)은 항상 관찰자를 넘겼으므로, 로그인 직후 계정을 한 번 확인해 기록했다. 새 구조에서는 계정 상태 쿼리의 소유자가 `Accounts` 하나이고 로그인은 항상 이를 거친다. 그래서 운영 코드에 분기를 추가하지 않는 한 "관찰자 없음" 조합을 만들 수 없다. 8.1절은 이런 테스트를 대체 Layer로 재현하겠다고 했지만, 대체 `Accounts`는 조회 자체를 없애 버리므로 같은 조합이 되지 않는다. 그래서 운영 조립으로 다시 썼다.

- 로그인 직후 계정 확인 1회가 횟수에 포함된다(`sends` 0 → 1).
- 이미 계정을 확인한 프로세스는 하루가 지나도 네트워크 없이 다음 확인 시각만 저장한다. 그래서 세션 재확인과 401·403·429 처리는 재시작한 공급자 인스턴스(아직 확인하지 않은 계정)로 검사한다.
- 운영 동작은 기준선과 같다. 기준선에도 "로그인 직후 1회 확인" 테스트가 따로 있었고, 해당 운영 분기(`isAccountChecked`)는 기준선 코드에서 확인했다.

**수명 테스트 추가.** `tests/pi-lifetime.test.ts`에 4개를 추가했다. 같은 시나리오를 기준선 API(`createDevinProvider`, `provider.attachSession`, `provider.shutdown`)로 옮겨 기준선 작업 트리에서 실행했고, 같은 기대값으로 통과했다. 네 번째 테스트는 9.4절의 스케줄러 결함을 고치기 전 코드에서 실패하는 것을 확인했다.

1. 한 프로세스의 두 확장 인스턴스는 수명이 따로다. 하나를 종료하면 그 인스턴스의 요청만 "The Devin provider shut down."으로 끝나고, 다른 인스턴스의 진행 중 요청과 카탈로그 갱신은 계속된다.
2. 종료 뒤 같은 공급자 객체는 다음 `session_start` 전까지 요청과 갱신을 거절하고, 그 뒤 다시 처리한다. 종료·시작을 두 번 반복해도 같은 런타임으로 동작한다.
3. 종료 시점에 진행 중이던 카탈로그 갱신은 다음 `session_start` 뒤에 응답이 도착해도 publish하지 않고 목록을 바꾸지 않는다.
4. 공급자 호출보다 오래 사는 요청도 응답 프레임을 한 번에 많이 처리하는 동안 타이머와 입력 처리에 이벤트 루프를 넘긴다.

### 9.4 검증 중 발견해 고친 결함

| 결함 | 원인과 영향 | 수정 |
| --- | --- | --- |
| 설치한 패키지가 로드되지 않음 (1차 전환 `eb95e1e`부터) | `@effect/platform-node`를 패키지 index로 import하면 `NodeRedis.js`도 로드되고, 이 모듈은 peer 의존성 `redis`를 요구한다. Pi 설치기는 `--omit=peer`·`--legacy-peer-deps`로 설치하므로 `redis`가 없다. 기준선 배포본을 새 소비자에 설치하면 "Failed to load extension: Cannot find module 'redis'"로 실패하고 도구·명령이 0개 등록된다. 소스 작업 트리에는 `redis`가 설치되어 있어 드러나지 않았다. | `core/services/platform.ts`, `core/auth/callback-server.ts`에서 `@effect/platform-node/NodeFileSystem` 같은 하위 경로로 import한다. 하위 경로 모듈이 `NodeRedis`·`redis`에 닿지 않음을 import 추적으로 확인했다. |
| 배포본 대상 공급자 테스트가 import 단계에서 실패 | 재구성 중 `tests/helpers.ts`가 `src/cli`를 import하게 되었다. 배포본에는 CLI가 없다. | CLI 전용 도우미를 `tests/cli-helpers.ts`로 옮겼다. |
| 긴 응답 처리 중 타이머·입력이 멈춤 (이번 재설계에서 생김, 검토자 2명이 지적) | `streamSimple`이 `runtime.runSync` 안에서 요청 Fiber를 포크해, 요청이 `runSync`의 동기 스케줄러를 물려받았다. 이 스케줄러는 2048개 연산마다 양보할 때 `setImmediate` 대신 마이크로태스크를 쓴다. 프레임 4000개를 한 덩어리로 받은 재현에서, 첫 텍스트 이벤트 때 예약한 `setImmediate`가 기준선에서는 4번째 이벤트 뒤에 실행됐지만 재설계 코드에서는 4004개 이벤트가 모두 끝난 뒤에 실행됐다. Pi TUI 그리기와 Esc 중단 입력이 그만큼 늦어진다. 사이드킥 자식 이벤트 처리도 같은 원인을 가졌다. | `onDefaultScheduler`로 요청 Fiber와 자식 이벤트 처리를 Effect 기본 스케줄러(기준선 `Effect.runFork`와 같은 인스턴스)에서 실행한다. 수정 뒤 같은 재현에서 4번째 이벤트 뒤에 실행됐다. |
| 실제 Pi 실행 경로 검사(`host-contract.mjs`)가 시작되지 않음 (1차 전환부터) | 가짜 서버가 없어진 `src/core/protocol/transport.ts`와 동기 codec API를 썼다. 샌드박스 대조 검사는 옮겨진 `src/pi/provider.ts`를 읽어 `EPERM` 대신 `ENOENT`를 받았다. | `mock-devin.mjs`가 `frames.ts`의 `encodeFrame`과 codec Effect를 `Effect.runSync`로 실행하게 했고, 대조 경로를 `src/pi/adapters/pi/provider.ts`로 바꿨다. |

### 9.5 검증 결과

작업 디렉터리는 `apps/pi-devin`, Node.js 24.14.0, Pi 1.3.0이다.

| 검증 | 결과 |
| --- | --- |
| `npx tsgo -p tsconfig.json` | 통과 |
| `npx vitest run` | 32개 파일, 241개 테스트 통과 (기준선 237개 + 수명 테스트 4개) |
| `biome lint apps/pi-devin` (저장소 루트) | 오류 31, 경고 9, 정보 27. 기준선과 같고 새 지적 없음 |
| `validate-package.mjs --expect … --runtime --pack` | `pass`. 배포본에 `src` 파일 98개가 있고 개발 전용 경로는 없음. `inventory.json`의 `requiredFiles`(166개)를 새 파일 구성으로 다시 만들었다. |
| `import-closure.mjs . --expect verification/inventory.json` | `ok`, 93개 파일, 문제 0 |
| 새 소비자에 배포본 설치 → `prepare-artifact.mjs` → 압축 해제본 `--runtime` | `pass` (기준선은 위 `redis` 결함으로 실패) |
| 배포본 대상 공급자 테스트 (`artifact-vitest.config.mjs`) | 7개 파일, 68개 테스트 통과(`pi-lifetime` 포함). 매핑 기록상 테스트가 직접 import한 43개 모듈을 압축 해제본으로 연결했고, 그 모듈이 import하는 파일도 압축 해제본 안에서 읽힌다. |
| 실제 Pi 실행 경로 (`host-contract.mjs --package-root <압축 해제본>`, `sandbox-exec`) | help 9/9, rpc 37/37, print 10/10, json 10/10, oauth 11/11, cache 8/8, tui 18/18 통과 |
| CLI 출력 비교 (기준선 작업 트리와 같은 입력 26개) | 표준 출력·표준 오류·종료 코드 모두 같음. 1건은 임시 디렉터리 경로만 다름. 검토 반영 수정은 CLI가 쓰지 않는 `src/pi`만 바꿨으므로 다시 실행하지 않았다. |
| `node ../../scripts/release/changelog.mjs check` | 통과 |

### 9.6 확인하지 못한 사항

- SWE-2 외 모델, TUI 전용 화면(`/devin` 패널, 상태 표시줄, `/devin-fusion` 선택 화면)의 실서비스 동작. 실서비스 검증 범위는 9.8절에 있다.
- 50개 프롬프트보다 긴 세션과 자동 압축(compaction)이 일어나는 길이의 실서비스 대화
- 최소 지원 버전 Node.js 22.19.0, macOS 이외 운영체제에서의 실행
- 처리 지연과 메모리 사용량. 측정하지 않았다.
- 레이어 생성은 첫 `runtime.runSync` 안에서 동기로 끝나야 한다. 생성 중 자동 양보(2048개 연산)나 비동기 작업이 생기면 등록이 "An asynchronous Effect was executed with Effect.runSync"로 실패한다. 지금은 테스트와 실제 Pi 실행 경로에서 문제가 없지만, 레이어를 늘릴수록 위험이 커진다.

### 9.7 독립 검토 결과

검토자 2명(실행·수명, 기능 보존·배포 구성)이 각자의 작업 트리에서 검토했다. 두 검토자 모두 읽기 전용 도구만 받아 직접 실행하지 못했으므로, 각 지적은 이 문서의 작성자가 재현한 뒤 처리했다.

| 지적 | 심각도 | 재현 | 처리 |
| --- | --- | --- | --- |
| `runSync`에서 포크한 요청·자식 이벤트 Fiber가 동기 스케줄러를 물려받음 (두 검토자 공통) | 경미 → 동작 차이 확인 | 재현함. 기준선 4번째 이벤트, 재설계 4004번째 이벤트 뒤에 매크로태스크 실행 | 수정(9.4절), 회귀 테스트 추가 |
| 사용량 테스트가 운영 코드가 아닌 하네스의 복사본을 검사함 | 경미 | 확인함. 하네스와 `UsageStatusLive`가 같은 식을 따로 가짐 | `currentAccountUsage`로 묶어 양쪽이 같은 함수를 쓴다. |
| `/devin` 갱신 실패 테스트가 "재구성 정확히 1회"에서 "재구성됨"으로 약해짐 | 참고 | 확인함 | 정확히 1회를 다시 검사한다. 재구성을 두 번 하도록 바꾼 코드에서 실패하는 것을 확인했다. |
| `makeProviderRuntime`을 쓰는 곳이 없음 | 참고 | 확인함. 하네스가 같은 식을 복사해 씀 | 하네스가 운영 팩토리를 쓴다. |
| `AGENTS.md`의 서비스 위치·`R = never` 설명이 실제와 다름 | 참고 | 확인함 | 예외(`state.ts`·`guard.ts`·`login.ts`, `Scope` 요구 두 개)와 기본 스케줄러 규칙을 적었다. |
| `verification/README.md`의 개수(44, 51)가 오래됨, `pi-lifetime`이 배포본 검사 대상에 없음 | 참고 | 확인함 | 개수를 166, 68로 고치고 `artifact-vitest.config.mjs`에 `pi-lifetime`을 추가했다. |
| CLI가 모든 명령에서 레이어 생성 때 `process.stdin.isTTY`를 읽음 (기준선은 로그인 때만) | 낮은 확신 | 재현하지 못함. 파이프·의사 터미널·닫힌 stdin에서 `status`·`models`의 출력, 종료 코드, 종료 시간이 기준선과 같았다. 로그인 판단 조건도 같다. | 변경하지 않음 |

검토자가 기준선과 같다고 확인한 범위는 등록·이벤트 순서, 종료 순서, 수명 갱신, 인증 세대와 재로그인 후속 처리, 요청 파이프라인, 저장 형식, wire, CLI 출력, 배포 구성이다.

### 9.8 실서비스 검증

이 재설계의 배포본(`89b92e7c…`)을 실제 Devin 서비스에 연결해 SWE-2 무료 모델로 프롬프트 50개를 보냈다. 기존 실서비스 검사 도구(`verification/scripts/live/`)를 썼다. 모든 Pi 프로세스는 `sandbox-exec` 안에서 돌았고, 가드가 다음을 강제했다.

- 허용 호스트: `server.codeium.com`, `api.devin.ai`
- 허용 UID: `swe-2-medium`, `swe-2-high`
- 프로세스 전체 상한: 모델 요청 80회
- 무료 등급 확인: 카탈로그에 무료 등급으로 나오지 않으면 이후 모델 요청을 모두 막는다.

1차 전환 뒤 이 도구도 쓸 수 없는 상태였으므로 다음을 고쳤다.

- 가드가 Effect codec을 codec과 같은 effect 사본으로 실행한다.
- 기존 07 계획은 그대로 두고(해시 변경 없음을 확인), 새 배포본에 고정한 08 계획과 긴 세션 케이스를 추가했다.

| 단계 | 결과 |
| --- | --- |
| 가짜 서버 dry-run | 12/12 통과. 승인하지 않은 UID, 사이드킥 UID, 요청 상한, 무료 등급 아님, 소켓 수준 호스트 차단, API 키 환경 변수 비상속 같은 거부 대조 검사를 포함한다. |
| 로그인 | 임시 Pi TUI에서 `/login`을 실행하고, 사용자가 자기 브라우저에서 로그인했다. 코드 교환·계정 상태·카탈로그·팀 설정 4건이 모두 200이었고, 모델 요청은 0건이었다. 카탈로그에서 두 UID 모두 활성·`MODEL_COST_TIER_FREE`였다. |
| 단일 프롬프트 케이스 5개 | 모두 통과: `/devin` 추천 필터 켜기·끄기(56 → 13 → 56개), medium·high 응답, add 도구, Fusion 사이드킥 |
| 긴 세션 45개 프롬프트 | 통과. 194초 |
| 전체 | 7개 케이스 통과. 모델 요청 62회(`swe-2-medium` 49회, `swe-2-high` 13회)가 모두 HTTP 200이었고, 가드 차단(Pi 도구 관리자의 github.com 다운로드 제외)과 중단은 없었다. |

긴 세션에서 확인한 동작은 다음과 같다.

- 도구 호출 8번이 모두 `toolUse → stop`으로 끝났고 결과가 맞았다.
- 사고 수준마다 정해진 UID로 요청을 보냈다(medium → `swe-2-medium`, high → `swe-2-high`).
- 16번째 프롬프트는 스트리밍 도중 중단해 `aborted`("This operation was aborted")로 끝났다. 다음 프롬프트는 정상이었다.
- 23번째 프롬프트 직전에 Pi를 종료하고 같은 세션 파일로 다시 시작했다. 재시작 뒤에도 처음에 준 코드 단어를 맞혔다. 마지막 무렵에는 두 코드 단어를 모두 맞혔다.
- `/devin` 보고서의 세션 요청 수(53)가 가드 기록부의 모델 요청 수와 같았다. 프롬프트 캐시 읽기는 120k 토큰이었다.
- 요청 직전 계정 확인(`GetUserStatus`)은 로그인을 포함해 63회였다. 요청마다 확인하는 설계대로다.

관찰한 점이 하나 있다. 6번째 응답(high)은 정답 뒤에 `<|close|>argument<|sep|>…` 같은 모델 특수 토큰이 텍스트로 섞여 나왔다. 응답 누적 코드는 이번 재설계에서 바뀌지 않았고, 확장은 서버가 보낸 텍스트를 이어 붙인다. 원시 프레임은 기록하지 않아 원인을 서버나 모델 쪽으로 확정하지는 못했다.

이번 로그인으로 서버에 생긴 세션은 폐기하지 않았다. 새 자격 증명이 있던 임시 상태는 실행 뒤 삭제했다. 기록은 `verification/followup/live/`의 `*-08.json`에 있다.

[base-commit]: https://github.com/buYoung/pi-packages/commit/eb95e1ec9d71bc6a67ee95941386cdac03084099
[source-provider]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/provider.ts#L54-L111
[source-extension]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/extension.ts#L28-L92
[source-inference]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/provider/inference.ts#L47-L168
[source-inference-probe]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/provider/inference.ts#L78-L93
[source-account-auth]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/auth/account-auth.ts#L58-L131
[source-accounts]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/provider/accounts.ts#L20-L72
[source-model-source]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/models/source.ts#L54-L161
[source-lifecycle]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/lifecycle.ts#L56-L260
[source-sidekick-tool]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/sidekick/tool.ts#L66-L214
[source-sidekick-runtime]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/pi/sidekick/runtime.ts#L187-L244
[source-connect-client]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/core/protocol/connect-client.ts#L46-L121
[source-client]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/core/client.ts#L21-L63
[source-login]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/core/auth/login.ts#L23-L40
[source-fingerprint]: https://github.com/buYoung/pi-packages/blob/eb95e1ec9d71bc6a67ee95941386cdac03084099/apps/pi-devin/src/core/protocol/fingerprint.ts#L25-L38
[source-main-transport]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-devin/src/core/protocol/transport.ts#L295-L340
