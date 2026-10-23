# Claude Bridge의 Effect v4 기반 전면 재설계 근거

## 1. 설계 방향과 변경 범위

> **Layer 기반 기능 모듈화 + 쿼리 소유권·상태·수명 관리 전면 재설계**

`apps/pi-claude-bridge`의 내부 구조를 Effect v4 중심으로 전면 재설계한다. 기존 factory를 조금씩 감싸거나 작은 구조부터 확장하는 방식은 이 문서의 전제가 아니다. 목표 구조를 먼저 정하고, 기존 내부 구현을 그 구조로 교체하는 방향을 권장한다.

보존 대상은 기존 코드의 형태가 아니라 **외부에서 관찰되는 기능과 동작 계약**이다.

| 구분 | 이번 전환의 기준 |
| --- | --- |
| 재설계 대상 | 디렉터리, 내부 API, 서비스 조립, 쿼리 상태 표현, 비동기 실행·취소·정리, 테스트 구성 |
| 유지 대상 | Pi 공급자 계약, 기록·설정 형식, 모델·프롬프트 정책, 도구 전달 순서, 실패·취소 의미, 인스턴스 간 연동 |
| 필수가 아닌 것 | 기존 내부 파일 경로, factory API, `__test` 구조, 임시 호환 facade 유지 |
| 도입하지 않는 것 | 기능을 선택적으로 누락시키는 별도 builder, 기존·신규 실행 엔진의 상시 공존, 요청하지 않은 retry·timeout 정책 |

기능별 서비스는 `Context.Service`로 정의하고 `Layer`로 조립한다. 쿼리별 상태와 자원은 명시적인 소유자 아래에 두고 `Scope`와 `Fiber`로 실행·정리를 연결한다. 파일은 책임에 따라 충분히 분리하되, 같은 쿼리의 상태를 서로 독립적인 여러 소유자로 나누지 않는다.

이 방향을 권장하는 이유는 현재 코드의 서비스 후주입, 상호 상태 변경, Pi 호출보다 오래 사는 SDK 쿼리 때문이다. Layer의 역할은 의존성 조립이다. 취소·도구 대기·늦은 완료의 안전성은 상태 소유권과 실행 경계에서 확보해야 하며, Layer가 자동으로 해결하지 않는다.

독자는 유지보수자와 전환 담당자다. 1–8절은 전환 전 코드 분석과 설계 판단을 기록한다. 목표 트리의 파일명과 서비스명은 설계상의 구분이며 공개 API가 아니다. 실제 구현 대응과 검증 결과는 9절에 기록한다. Effect 도입만으로 기능 보존, 성능 향상, 자원 누수 제거가 입증되지는 않는다.

분석 대상은 패키지 `0.13.1`, 커밋 `bdb11fb46bebe4ac130f3be9c982741ba77e1265`다. 코드 근거 링크는 이 커밋에 고정했다. 외부 문서와 npm 배포 정보의 확인일은 2026-10-22 UTC다.

## 2. 전환 전 코드에서 확인한 사실

### 2.1 파일 분리는 되어 있지만 조립의 안전성은 관례에 의존한다

[`src/runtime.ts`][source-runtime]는 먼저 빈 객체를 `BridgeRuntime`으로 단언하고, 각 factory가 반환한 서비스를 같은 객체에 차례로 설치한다.

```typescript
const runtime = {} as BridgeRuntime;
const install = (services: object): void => { Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(services)); };
```

의존성을 받는 factory의 `Pick<BridgeRuntime, ...>`는 필요한 속성을 표현한다. 그러나 실제로 전달하는 객체는 아직 조립 중이며, 나중에 설치할 서비스까지 이미 존재하는 타입으로 취급된다. 현재 패키지는 factory가 조립 중에 다른 서비스의 실행 함수를 호출하지 않는다는 규칙으로 이 문제를 피한다.

이는 현재 조립이 실패한다는 증거가 아니다. 다만 새 모듈을 붙이는 사람이 초기화 규칙을 알아야 하며, 타입만으로 설치 완료를 판단할 수 없다는 뜻이다. `Layer`를 사용하면 필요한 서비스와 제공하는 서비스를 조립 단계에 표현할 수 있다. 이 이점을 얻으려면 전체 런타임을 타입 단언으로 전달하는 방식을 함께 제거해야 한다.

### 2.2 순환 의존성과 미러 변경 권한이 여러 모듈에 걸쳐 있다

[`createMirrorStore`][source-mirror]는 `activeQueryContexts`를 읽어 오래된 쿼리를 표시한다. 반대로 [`createQueryRegistry`][source-registry]는 runner가 종료되었고 남은 쿼리와 세션 문맥이 모두 없으면 `withdrawRebuildHook`을 호출한다.

```text
MirrorStore
    → QueryRegistry의 activeQueryContexts 사용

QueryRegistry
    → MirrorStore의 withdrawRebuildHook 호출
```

이것은 서비스 의존성의 순환이다. TypeScript 모듈이 실제로 순환 실행된다는 주장과는 다르다. 두 서비스를 그대로 Layer로 바꾸어도 이 책임 관계는 남는다.

미러를 변경하는 경로도 한곳에 모여 있지 않다.

| 현재 위치 | 변경하는 상태 |
| --- | --- |
| [`provider/stream.ts`][source-stream] | 미러의 `cursor` 직접 변경, 기록 재작성 표시 소비 |
| [`provider/completion.ts`][source-completion] | 완료·실패·취소·폐기 후 미러 갱신과 재구성 표시 |
| [`provider/tool-bridge.ts`][source-tool-bridge] | 조정 메시지 전송 실패 시 재구성 표시 |
| [`provider/registration.ts`][source-registration] | 미러 Map과 재작성 표시 집합 직접 초기화 |
| [`session/mirror-store.ts`][source-mirror] | 미러 갱신, 활성 쿼리의 오래된 기록 표시 |

권장 구조에서는 미러 변경을 `SessionService`의 작업으로 모으고, 쿼리 실행 서비스가 필요한 갱신 작업을 호출한다. 의존 방향은 `Query → Session`으로 고정한다. Session은 활성 쿼리의 내부 상태를 읽거나 수정하지 않는다.

기록 압축처럼 두 기능을 함께 변경하는 이벤트는 인스턴스 간 전달을 마친 뒤 이벤트 처리 계층이 Session과 Query에 각각 요청한다. 이 구조는 미러 변경 권한을 제한하면서도 모든 후속 처리를 하나의 거대한 Coordinator로 모으지 않는다.

### 2.3 Pi 출력 스트림이 끝나도 Claude 쿼리는 계속 살아 있다

[`streamClaudeAgentSdk`][source-stream]는 Pi가 새 프롬프트나 도구 결과를 전달할 때마다 호출된다. 기록이 여전히 유효한 기존 쿼리가 도구 결과를 기다리고 있으면 새 SDK 쿼리를 만들지 않고, 그 쿼리에 새 Pi 스트림과 현재 실행의 취소 신호를 연결한다. 기록이 변경되어 오래된 쿼리는 폐기하고 현재 기록으로 다시 시작한다.

따라서 다음 세 가지는 같은 단위가 아니다.

| 단위 | 실제 역할 | 구분하지 않을 때 생기는 회귀 |
| --- | --- | --- |
| Pi 공급자 호출과 출력 스트림 | 한 번의 모델 응답을 Pi에 전달 | 스트림 종료 시 SDK 쿼리도 닫으면 다음 도구 결과를 전달할 대상이 사라진다. |
| Claude SDK 쿼리 | 도구 호출과 결과 대기를 포함한 SDK 실행 | 이전 실행의 취소 신호가 남으면 쿼리를 이어받은 새 실행까지 중단된다. |
| Pi 세션 | 기록, 작업 디렉터리, 미러의 귀속 단위 | 다른 세션의 압축·종료가 현재 쿼리나 미러를 변경한다. |

일반적인 HTTP 요청처럼 요청 시작과 종료에 맞춰 모든 자원을 열고 닫는 구조는 이 브리지에 맞지 않는다.

### 2.4 도구 전달은 값뿐 아니라 순서도 계약이다

[`prompt-stream.ts`][source-prompt-input]의 `push()`는 메시지가 내부 큐에 들어간 시점에 완료되지 않는다. SDK가 generator의 `yield` 이후로 진행했을 때 완료된다. 현재 구현은 이 동작을 SDK의 stdin 쓰기 완료 확인으로 사용한다.

조정 메시지 쓰기에 성공하는 경로에서 [`deliverToolResults`][source-tool-bridge]는 이 확인을 기다린 다음 MCP 도구 결과를 반환한다. 두 값이 같은 stdin 경로를 사용하므로, 이 순서가 있어야 조정 메시지가 도구 결과보다 먼저 Claude Code에 도착한다.

```text
조정 메시지 입력
    → SDK의 stdin 쓰기 완료 확인
    → 대기 중인 MCP 도구 결과 반환
```

조정 메시지를 쓰지 못했을 때는 쿼리에 재구성 필요를 기록하고, 미러가 이미 있으면 미러에도 표시한 뒤 도구 결과는 계속 전달한다. 미러를 새로 만들 때도 그 표시를 유지한다. 조정 메시지 실패 때문에 도구 결과까지 버리거나 영구 대기시키지 않는 것도 기존 계약이다.

`Queue`에 값을 넣는 작업의 완료는 stdin 쓰기 완료와 다르다. Effect로 전환하더라도 외부 SDK와 연결되는 generator와 확인 응답의 의미는 보존해야 한다. 이 동작은 Claude Code와 SDK의 내부 처리에도 의존하므로, 타입 검사만으로 실제 전달 순서까지 검증할 수 없다.

### 2.5 확장 인스턴스의 종료와 공급자 함수의 마지막 호출은 일치하지 않는다

현재 [공급자 등록][source-registration]은 인스턴스별 소유권을 확인한다. 새 인스턴스가 로드되었다는 이유만으로 기존 공급자를 덮어쓰지 않는다. 세션별 기록 변경과 종료는 프로세스 공유 hook을 통해 실제 쿼리를 처리하는 인스턴스에 전달된다.

[쿼리 등록부][source-registry]는 runner가 종료되어도 쿼리나 세션 문맥이 남아 있으면 hook을 유지한다. [공급자 진입점][source-stream]은 이전 등록부가 해당 함수를 다시 호출하는 경우 hook에 다시 참여한다.

따라서 `session_shutdown` 하나에 인스턴스 전체의 `ManagedRuntime.dispose()`를 무조건 연결하면 기존 수명 계약을 깨뜨릴 수 있다. Effect 런타임을 어디에 만들지보다, 누가 계속 사용하는지와 종료 후 재진입을 어떻게 처리하는지가 우선이다.

## 3. 전면 재설계의 목표 구조와 책임

아래는 목표 구조의 대표 파일이다. 기존 경로를 유지하기 위한 절충안이 아니다. 계약·정책·상태 전이·외부 연동을 구분하며, 실제 구현에서는 책임이 같은 작은 helper를 합치거나 독립적인 책임을 추가로 분리할 수 있다. 순수 함수마다 서비스나 Layer를 만들지는 않는다.

```text
src/
├── index.ts                       # 기존 Pi 확장 진입점
├── app/
│   ├── layer.ts                   # 기능·외부 어댑터의 Layer 조립
│   ├── runtime.ts                 # 모듈 인스턴스의 고정 실행 환경
│   ├── requests.ts                # 일반 요청·도구 결과·요약 분기
│   └── session-events.ts          # 전달받은 세션 이벤트의 동기 처리
├── features/
│   ├── query/
│   │   ├── service.ts             # 시작·이어받기·취소·폐기 계약
│   │   ├── prepare.ts             # 반환 전 동기 준비와 쿼리 claim
│   │   ├── state.ts               # 쿼리 상태의 단일 소유자와 전이
│   │   ├── registry.ts            # 세션·도구 ID별 쿼리 조회
│   │   ├── lifecycle.ts           # Query Scope와 정리 순서
│   │   ├── turn.ts                # 쿼리 소유의 Pi 응답·연결 상태
│   │   ├── consume.ts             # SDK 이벤트 소비
│   │   └── completion.ts          # 결과 판정·Session 갱신·최종 발행
│   ├── tool-bridge/
│   │   ├── service.ts             # 쿼리에 귀속되는 도구 연결 핸들
│   │   ├── result-router.ts       # toolUseId로 결과와 핸들러 연결
│   │   ├── pending-results.ts     # 쿼리 소유의 대기 상태 구현
│   │   └── tool-mapping.ts        # 도구 이름·인자 변환
│   ├── session/
│   │   ├── service.ts             # 동기화·재구성·미러 갱신 계약
│   │   ├── mirror-store.ts        # Pi 세션별 미러 상태
│   │   ├── sync-policy.ts         # 재사용·재구성·UUID 교체 판단
│   │   ├── rebuild.ts             # Pi 기록으로 Claude 기록 재구성
│   │   ├── continuity.ts          # 재시작·브랜치 연결 정보
│   │   └── tool-result-carry.ts    # 이미지·저장 결과 보존
│   ├── prompt/
│   │   ├── service.ts             # 프롬프트 해석·투영 계약
│   │   ├── capture.ts             # 원본 지침과 상속 관계
│   │   └── projection.ts          # 프로젝트·스킬·도구 지침 투영
│   ├── summary/
│   │   └── service.ts             # 미러를 사용하지 않는 독립 요약
│   └── models/
│       ├── service.ts             # 모델·요금제 정보 제공
│       ├── policy.ts              # context window·reasoning 정책
│       └── plan-detection.ts      # 요금제 감지와 갱신
├── adapters/
│   ├── pi/
│   │   ├── registration.ts        # 공급자·이벤트 등록
│   │   ├── provider-stream.ts     # 동기 진입 계약과 Effect 실행 연결
│   │   ├── stream-events.ts       # Pi 이벤트·usage 표현 변환
│   │   ├── error-mapping.ts       # 원본 오류·취소 결과의 Pi 표현
│   │   └── instance-registry.ts   # 등록 소유권·인스턴스 간 전달
│   ├── claude/
│   │   ├── client.ts              # SDK query·interrupt·close 경계
│   │   ├── query-options.ts       # 최종 SDK 옵션 구성
│   │   ├── environment.ts         # 자식 프로세스 환경
│   │   ├── prompt-input.ts        # AsyncIterable와 stdin 쓰기 확인
│   │   └── mcp-server.ts          # MCP 프로토콜 연결
│   └── storage/
│       ├── configuration.ts       # 설정 파일 읽기·원자적 저장
│       └── session-files.ts       # 세션 파일 접근·안전한 정리
├── configuration/
│   └── service.ts                 # 설정 우선순위와 현재 설정 제공
└── diagnostics/
    └── service.ts                 # 기존 로그·진단 계약
```

### 3.1 조립·요청 분기·쿼리 완료의 책임을 구분한다

| 소유자 | 맡는 책임 | 맡지 않는 책임 |
| --- | --- | --- |
| `app/layer.ts` | 서비스 구현 선택과 의존성 제공 | SDK 쿼리 시작, 실행 중 상태 변경 |
| `app/runtime.ts` | 인스턴스 실행 환경 초기화와 최종 수명 | 세션 종료마다 런타임 재생성, 모델 정책 |
| `app/requests.ts` | 일반 요청·도구 결과·독립 요약의 진입 경로 선택 | 쿼리 완료 정책, 다른 서비스의 Map 직접 변경 |
| `app/session-events.ts` | 해당 인스턴스에 전달된 기록 변경·종료 처리 | SDK 파싱, 파일 직접 접근 |
| `features/query` | 동기 준비, 쿼리 상태·자원, 취소, 완료 순서와 Session 갱신 요청 | 미러 내부 필드 변경, 전역 공급자 등록 |
| `features/tool-bridge` | Query가 소유하는 핸들을 통한 결과 전달·대기 처리 | 독립적인 쿼리 수명 결정, 미러 직접 변경 |
| `features/session` | 미러 변경, 기록 재사용 판단과 재구성 | Query 역참조, Pi 스트림 종료 |
| `adapters` | 외부 API 호출과 형식 변환 | 기록 재사용 정책이나 새 retry 정책 결정 |

완료 처리를 독립적인 Coordinator에 반드시 모으지 않는다. 권장안은 Query 실행 서비스가 Session의 갱신 계약을 직접 사용하는 구조다. `app/requests.ts`는 요청 분기만 맡고, SDK 소비 완료를 판정하거나 미러 내부를 조작하지 않는다.

이 배치는 전면 재설계를 축소하려는 선택이 아니다. 쿼리 완료와 상태 소유권을 같은 기능 안에 두면서 Session의 저장 책임을 분리하려는 선택이다.

### 3.2 서비스 의존성은 단방향으로 조립한다

`Context.Service`는 필요한 기능의 계약을 식별한다. `Layer`는 그 계약을 만족하는 구현과 필요한 서비스를 연결한다. 이는 [Effect의 서비스와 Layer 문서][effect-layers]에 따른다.

```text
Pi 공급자 진입점
    → 요청 분기
        ├── QueryService
        │   ├── PromptService
        │   ├── SessionService → 세션 파일 어댑터
        │   ├── ToolBridge
        │   └── ClaudeClient
        └── SummaryService
            └── ClaudeClient
```

설정·모델·진단처럼 공통으로 사용하는 서비스는 필요한 소비자에게 Layer로 제공한다. 위 그림은 주요 실행 의존성을 나타내며 모든 공통 의존성을 나열한 것은 아니다.

권장 의존성 규칙은 다음과 같다.

1. `app/layer.ts`가 실행 구성을 조립한다. 기능 모듈은 다른 서비스의 계약을 사용하고, 호출할 때마다 실제 구현 Layer를 만들지 않는다.
2. 계약은 그 서비스를 소유한 모듈에 둔다. SDK 어댑터의 계약이 `adapters/claude/client.ts`에 있더라도 기능 코드는 그 계약을 사용하며 SDK를 직접 호출하지 않는다.
3. `Query → Session` 의존은 허용하고 `Session → Query` 역의존은 금지한다. Session은 쿼리 핸들이나 Pi 출력 스트림을 보관하지 않는다.
4. `ToolBridge`는 Query가 제공한 좁은 핸들로 작업한다. `QueryService` 전체를 다시 요구하거나 다른 쿼리의 상태에 접근하지 않는다.
5. 기능 모듈은 상위 요청 분기 계층을 역으로 호출하지 않는다. SDK 소비와 완료 처리는 쿼리 소유의 실행 안에서 이어간다.
6. 모든 서비스를 하나의 `BridgeRuntime` 객체로 전달하는 방식을 제거한다. 서비스가 요구하는 기능과 변경할 수 있는 상태를 계약에 드러낸다.

파일이 다르다는 사실만으로 분리가 완료된 것은 아니다. 서비스 내부 Map을 다른 모듈이 직접 수정하거나 하위 기능이 상위 실행 환경 전체를 요구한다면 같은 결합이 남아 있다.

### 3.3 세션 이벤트는 인스턴스 간 전달 후 동기적으로 처리한다

이벤트를 받은 확장 인스턴스와 실제 공급자 쿼리를 처리하는 인스턴스가 다를 수 있다. [기존 공유 hook][source-mirror]과 [세션 해제 hook][source-registry]의 전달 의미를 보존한다.

```text
Pi 압축 이벤트
    → 이벤트를 받은 Pi 어댑터
    → 프로세스 공유 레지스트리에서 세션 ID로 각 인스턴스에 전달
    → 각 인스턴스의 session-events 처리
        → SessionService: 자신의 해당 미러를 재구성 대상으로 표시
        → QueryService: 자신의 해당 쿼리를 오래된 상태로 표시
```

한 인스턴스는 자신의 상태만 변경한다. 다른 세션의 쿼리와 미러는 건드리지 않는다. hook 참여·이탈과 공급자 등록 소유권은 `adapters/pi/instance-registry.ts`가 관리한다.

이벤트 처리는 표시 작업을 끝낸 뒤 반환해야 한다. 비동기 이벤트 큐에 넣고 즉시 반환하면 다음 도구 결과가 오래된 쿼리로 전달될 수 있다. 결합도를 낮춘다는 이유로 처리 순서를 바꾸지 않는다.

### 3.4 동기 준비를 끝낸 뒤 Pi 스트림을 반환한다

기능 보존 조건은 단순히 `streamSimple`의 반환 타입을 유지하는 것이 아니다. 새 쿼리 경로에서는 반환 전에 다음 작업을 기존 순서에 맞게 완료해야 한다.

- 해당 세션의 재진입 판정과 프롬프트 검증
- Pi 출력 스트림 claim과 쿼리별 상태 초기화
- 세션 동기화와 기록 재작성 표시 소비
- SDK 옵션 구성과 쿼리 핸들 생성
- 활성 쿼리 등록과 현재 호출의 취소 신호 연결

기존 쿼리를 이어받는 경로는 새 SDK 쿼리를 만들지 않고 현재 스트림과 취소 연결을 교체한다. 준비 이후에도 계속되는 SDK 소비·도구 결과 전달 등은 쿼리 Scope가 소유하는 비동기 작업으로 관리한다. 독립 요약은 별도의 Summary Scope를 사용한다.

이 동기 계약은 [두 번 연속 호출한 직후 활성 쿼리가 두 개인지 확인하는 기존 테스트][source-querycontext-test]와 [SDK 핸들 등록 구현][source-completion]에서 확인된다. 준비를 전부 비동기 작업으로 넘기면 두 번째 호출의 재진입 판정이 달라질 수 있다.

[Effect 4.0.5의 ManagedRuntime][effect-managed-source]에는 `runSync`가 있다. 다만 Layer 초기화 또는 실행 과정에 비동기 경계가 남아 있으면 동기 실행은 실패한다. 미조립 Layer라도 동기적으로 빌드를 끝내면 실행할 수 있지만, 호출 중 초기화에 의존하는 설계는 피한다. 권장안에서는 공급자 진입점을 노출하기 전에 Layer 조립을 완료하고, `query/prepare.ts`가 사용하는 경로를 동기 실행 가능하게 유지한다. `runFork`가 동기적으로 실행을 시작한다는 사실만으로 준비 완료까지 보장된다고 가정하지 않는다.

동기 throw와 스트림 error의 경계도 보존한다. 예를 들어 [SDK 옵션 조립의 중복 `extraArgs` 오류][source-options]를 무조건 스트림 error로 바꾸는 것은 구조 변경이 아니라 실패 동작 변경이다.

## 4. 쿼리 수명과 상태를 분리해야 하는 이유

### 4.1 자원은 Claude 쿼리에 귀속시킨다

```text
브리지 인스턴스
├── ManagedRuntime
├── SessionIndex
│   ├── Pi 세션 A → 미러와 쿼리 참조
│   └── Pi 세션 B → 미러와 쿼리 참조
├── QueryScope Q1
│   ├── SDK 쿼리 핸들
│   ├── 이벤트 소비 Fiber
│   ├── 프롬프트 입력과 쓰기 확인 대기
│   ├── 도구 연결 핸들
│   └── CurrentTurnBinding
│       ├── 현재 Pi 출력 스트림
│       └── 현재 실행의 AbortSignal 연결
├── QueryScope Q2
│   └── 다른 세션 또는 재진입 호출의 독립 자원
└── SummaryScope
    └── 미러를 사용하지 않는 일회성 SDK 쿼리
```

`QueryScope`와 `SummaryScope`는 이 문서에서 제안하는 소유권 단위이며 Effect의 별도 API 이름이 아니다. 구현에서는 `Scope`로 표현한다. `Fiber`는 Effect가 실행하고 종료를 관리하는 비동기 작업이다.

이 트리에서 `SessionIndex`는 조회용 정보다. 활성 쿼리를 세션 종료와 동시에 무조건 닫히는 자식 Scope로 표현하지 않았다. 현재 구현은 세션 문맥이 해제되어도 진행 중 쿼리가 자신의 실행 신호에 따라 정리되는 동작을 갖기 때문이다.

`CurrentTurnBinding`은 교체 가능한 연결이다. 다음 Pi 호출이 기존 쿼리를 이어받으면 이전 취소 listener를 제거하고 현재 호출의 listener를 연결한다. 이전 호출의 정리가 새 연결을 제거해서는 안 된다. 현재 코드도 [취소 연결과 완료 처리][source-completion]에서 이 소유권을 확인한다.

인스턴스 내부에서 공유하는 설정·진단·조회 서비스와 쿼리별 가변 상태를 같은 Layer 인스턴스로 취급하지 않는다. 공통 서비스는 조립한 런타임 안에서 재사용하고, 쿼리별 자원과 대기 상태는 쿼리를 열 때 생성해야 한다.

### 4.2 쿼리 상태의 소유자는 하나이고 내부 표현은 나눌 수 있다

[`QueryContext`][source-query-context]에는 SDK 핸들, Pi 출력, 취소 연결, 대기 중 도구, 기록 변경 표시, 사용량 제한 정보가 함께 있다. 새 구조에서는 이 내용을 역할별로 분리하되, 하나의 쿼리 실행 단위가 생성·교체·종료를 소유하도록 한다. 이 소유자를 `QueryRun`이라고 부른다. 이는 제안하는 내부 개념이며 새로운 공개 API 이름이 아니다.

| 상태 종류 | 수명·교체 소유자 | 구현 위치와 내용 |
| --- | --- | --- |
| 쿼리 수명 | `QueryRun` | `query/state.ts`, `query/lifecycle.ts`: 생성됨·활성·종료 중·종료됨 |
| 도구 대기와 라우팅 | `QueryRun` | 쿼리 전용 `ToolBridge` 핸들: 도구 ID, 대기 핸들러, 먼저 도착한 결과 |
| 현재 Pi 출력 | `QueryRun` | `query/turn.ts`: 스트림, 출력 블록, 시작·완료 여부 |
| 쿼리 기록의 유효성 | `QueryRun` | 이 쿼리가 시작한 기록이 오래되었는지 여부 |
| 미러 상태 | `SessionService` | 세션별 cursor, 재구성·UUID 교체 필요 여부 |
| 사용량 제한 정보 | `QueryRun` | 보류된 알림과 해당 실패에 연결된 제한 정보 |

현재 [도구 결과의 소유 쿼리를 찾는 함수][source-query-routing]는 `pendingToolCalls`, `pendingResults`, `turnToolCallIds`를 함께 본다. 새 쿼리 시작과 폐기에서도 이 상태들을 일관되게 바꿔야 한다. 관련 코드가 여러 파일에 있어도 각 파일이 별도의 전역 Map이나 독립적인 종료 권한을 가져서는 안 된다.

`QueryRun`은 좁은 작업을 통해 상태를 변경한다. `ToolBridge`가 대기 결과를 구현하거나 `turn.ts`가 출력 블록을 관리하더라도, 쿼리 교체 후 이전 핸들이 새 쿼리의 상태를 바꾸는 일은 허용하지 않는다. `registry.ts`는 쿼리를 조회하는 색인이지 상태 소유자를 하나 더 만드는 계층이 아니다.

쿼리 수명의 예시는 아래와 같다.

```text
Created → Active → Closing → Closed
    └───────────────▲
       시작 실패·취소
```

`Active`에는 응답 수신과 도구 결과 대기가 포함된다. 여러 도구가 동시에 진행될 수 있으므로 `Running`과 `WaitingForTools`를 전체 쿼리에 적용하는 상호 배타적인 상태로 사용하지 않는다. 도구 대기 여부는 도구별 상태로 판단한다.

종료 이유는 완료, 실패, 취소, 기록 변경에 따른 폐기로 구분한다. 이 내부 표현을 재설계하더라도 Pi의 기존 `stopReason`과 오류 문구는 보존한다.

### 4.3 Scope는 정리 시점을 제공하지만 정리 순서를 대신 설계하지 않는다

[Effect의 Scope][effect-scope]는 등록된 자원 해제 함수를 실행한다. 그러나 SDK 프로세스를 먼저 닫아도 되는지, 대기 중인 MCP 핸들러를 먼저 응답해야 하는지는 브리지의 계약이다.

취소·폐기에서는 다음 조건을 보존해야 한다.

- 종료되는 쿼리로 새 결과가 잘못 연결되지 않아야 한다.
- 프롬프트 쓰기 확인 대기를 끝내고, 대기 중인 MCP 핸들러에 응답한 뒤 SDK를 중단·종료해야 한다.
- 취소 listener, 입력 핸들, Pi 스트림, 미러 갱신은 해당 쿼리가 여전히 소유한 경우에만 정리하거나 변경해야 한다.
- 폐기된 쿼리의 늦은 완료가 교체 쿼리의 스트림이나 미러를 갱신해서는 안 된다.
- 정상 완료·실패·취소가 겹쳐도 Pi 출력 스트림의 최종 결과는 중복 발행하지 않아야 한다.

이 조건은 현재 [완료·폐기 처리][source-completion]와 [도구 대기 해제][source-tool-bridge]에 이미 존재한다. Scope로 옮길 때도 유지해야 한다. Scope를 사용한다는 이유만으로 정리 순서가 보존된다고 간주해서는 안 된다.

완료 처리는 `query/completion.ts`가 소유한다. 기존 완료 경로의 다음 순서를 보존한다.

```text
폐기·교체 여부 확인
    → 현재 실행의 취소 여부 판정
    → 정상 완료 또는 일반 실패에 필요한 Session 갱신
    → 최상위 쿼리라면 재진입 판정용 활성 상태 해제
    → 소유한 Pi 스트림의 최종 결과 발행
    → 소유권을 확인하며 라우팅 등록·대기·listener·SDK 자원 정리
```

이 흐름은 조건 분기다. 폐기된 쿼리는 교체 쿼리를 갱신하거나 그 스트림에 최종 결과를 발행하지 않는다. 취소도 정상 완료처럼 cursor를 전진시키지 않고 기존 재구성·UUID 교체 정책을 따른다.

정상 완료와 일반 실패의 최상위 쿼리는 최종 결과 발행 전에 재진입 판정용 활성 상태를 해제해야 한다. 그래야 다음 Pi 호출이 끝난 쿼리를 재진입 대상으로 오인하지 않는다. 라우팅 등록의 최종 해제는 이 상태 변경과 구분한다. 재진입 쿼리를 포함한 최종 정리는 기존 구현처럼 소유권을 검사하며 수행한다.

finalizer의 등록·실행 순서와 비동기 경계를 이 조건에 맞춰 설계해야 한다. 비동기 소비를 분리하더라도 그 완료 작업은 Pi 호출이 아니라 Query Scope의 수명에 속한다.

### 4.4 런타임은 인스턴스에 유지하고 세션 종료와 구분한다

`ManagedRuntime`은 Pi처럼 외부 호스트가 실행 진입점을 소유한 환경에서 Effect 서비스를 실행하는 수단이다. `dispose()`는 해당 런타임이 소유한 자원의 수명을 끝낸다. [공식 런타임 문서][effect-runtime]와 [4.0.5 구현][effect-managed-source]에서 이 동작을 확인했다.

권장안은 **모듈 인스턴스마다 런타임을 유지하고, 일반적인 `session_shutdown`에서 폐기·재생성하지 않는 것**이다. 기존 등록부가 같은 공급자 함수를 다시 호출하면 같은 인스턴스 상태를 사용하고 필요한 hook에 다시 참여한다.

이 선택은 기존 factory 구현을 유지하려는 것이 아니다. 재설계 후에도 다음 상태의 연속성이 필요하기 때문이다.

- [등록 이후 설정되는][source-registration] 공급자 설정, 모델 정책과 모델 갱신 연결
- [요금제 감지 상태][source-plan-detection]와 알림 상태
- 완료된 스트림·폐기된 쿼리의 식별 정보
- 공유 레지스트리에서 소유자를 식별하고 해제하는 등록 핸들

기존 내부 함수명과 클래스는 바꿀 수 있다. 다만 등록할 때 사용한 소유권과 해제할 때 확인하는 소유권은 일치해야 한다. 세션 전환으로 다른 인스턴스의 공급자를 덮어쓰거나 기존 호출이 새로 비워진 상태를 사용하게 해서는 안 된다.

hook 참여·이탈은 별도의 멱등 연산으로 관리한다. SDK 핸들, 입력 대기, 도구 핸들러와 소비 Fiber는 Query Scope 또는 Summary Scope에서 정리한다. 프로세스 공유 레지스트리는 인스턴스 간 전달용이며 모든 쿼리를 하나의 전역 런타임에 합치는 장소가 아니다.

런타임의 최종 `dispose()`는 진행 중 작업이 없고 해당 인스턴스로 다시 호출되지 않는 것이 보장되는 경로에만 둔다. 그런 신호를 호스트에서 확보하지 못하면 임의의 세션 종료를 최종 해제로 취급하지 않는다.

상태와 등록 핸들을 별도 지속 컨테이너에 보존하면 런타임 재생성도 기술적으로 가능하다. 그러나 이번 권장안은 그 추가 구조를 채택하지 않는다. 전면 재설계의 범위가 크다는 이유로 기존 동작에 필요하지 않은 재생성 체계까지 추가할 이유는 없다.

## 5. Layer가 자체 builder보다 적합한 이유

현재 factory의 생성·조립은 동기 방식이다. SDK 소비와 도구 전달까지 동기라는 뜻은 아니다. Layer 도입의 직접적인 이점은 필요한 서비스와 구현을 명시적으로 연결하는 데 있고, 쿼리 수명 개선은 Scope·Fiber·상태 소유권 설계에서 얻는다.

평가 기준은 조립 문법의 모양이 아니라 다음 네 가지다.

1. 필요한 서비스와 초기화 관계를 드러내는가.
2. 쿼리별 자원 수명과 취소를 같은 실행 모델로 관리하는가.
3. 테스트에서 SDK·저장소 구현을 바꾸기 위해 운영 코드를 변경하지 않아도 되는가.
4. 현재 존재하지 않는 기능 조합이나 플러그인 체계를 추가하지 않는가.

| 대안 | 얻는 점 | 남는 비용 또는 문제 | 판단 |
| --- | --- | --- | --- |
| 현재 factory를 유지하고 명시적 인자로 연결 | 의존성이 추가되지 않는다. 순환 책임을 분리하면 조립도 개선된다. | 기존 실행·취소·정리 체계가 남으며 Effect 중심 전면 재설계와 다르다. | 코드 분리만 목표라면 가능하지만 이번 목표의 최종안으로 선택하지 않는다. |
| 기능 서비스 + Layer + 쿼리 Scope | 의존성 조립과 실행·오류·정리를 Effect 중심으로 재설계한다. | 기존 내부 API·상태·테스트를 재편하고 동작 보존을 검증해야 한다. | 이번 전면 재설계의 권장안이다. |
| Effect + 조립·수명 관리까지 맡는 자체 builder | 여러 조립 구성을 별도 문법으로 표현한다. | Layer 외에 의존성 검사·기능 조합·초기화 순서·해제를 위한 API를 추가로 유지한다. | 현재는 추가 비용을 정당화할 요구가 없다. |
| 기존 코드를 큰 Effect 하나로 감싸기 | 호출 지점에서 Effect를 실행하는 형태로 바꾸기 쉽다. | 내부 가변 상태, Promise 연결, 취소 소유권은 그대로 남는다. | 실행 구조 전환이라는 목표를 충족하지 못한다. |

Builder도 타입 수준에서 필수 기능이나 순서를 검사하도록 설계할 수 있다. 따라서 builder가 본질적으로 안전하지 않다는 판단은 아니다. 다만 현재 브리지에는 사용자가 독립적으로 선택하는 여러 실행 제품 구성이 없다. `.withHistory().withTools().withSummary()`가 누락된 조합까지 지원할 이유가 없다.

예를 들어 독립 요약은 일반 요청과 다른 실행 경로지만, 그 사실만으로 별도 조립 제품이 되는 것은 아니다. 전체 공급자 구현은 두 경로를 모두 제공하고, `cacheRetention: "none"`이라는 기존 계약에 따라 경로를 선택하면 된다.

향후 외부 사용자가 실제로 여러 유효한 구성을 조립해야 한다면 builder를 재검토할 수 있다. 그 경우에도 서비스 의존성과 자원 수명은 Layer와 Scope가 맡고, builder는 구성 선택만 표현하는 얇은 계층으로 제한하는 것을 권장한다.

## 6. 전면 Effect 적용의 범위와 실행 계약

### 6.1 내부 실행 체계는 교체하고 외부 API는 어댑터로 연결한다

전면 전환의 대상은 부수 효과, 오류 전달, 비동기 작업, 자원 정리다. 기존 실행 코드를 큰 Effect 하나로 감싸거나 일부 경로만 Effect로 바꾼 상태를 최종 구조로 삼지 않는다.

| 대상 | 목표 구조 | 이유 |
| --- | --- | --- |
| SDK 실행·중단·종료, 설정·세션 파일 접근 | 서비스와 어댑터의 Effect 작업 | 실패와 자원 해제 책임을 호출 흐름에 드러낸다. |
| SDK 소비·도구 전달·일회성 요약 | 소유 Scope에 연결된 Fiber와 명시적인 종료 처리 | 진입 함수가 반환된 뒤에도 남는 작업의 주인을 식별한다. |
| 도구 결과와 쓰기 확인 대기 | 쿼리 소유 상태, 필요한 `Deferred`·`Queue` | 기존 ID 매칭과 stdin 쓰기 확인 시점을 보존한다. |
| 미러·쿼리의 가변 상태 | 소유 서비스의 작업으로만 변경 | 다른 모듈의 직접 Map·필드 변경을 제거한다. |
| 모델 선택·인자 변환·기록 변환 정책 | 일반 함수 | 외부 자원이 없는 계산에 실행 환경을 강제하지 않는다. |
| Pi·SDK가 요구하는 Promise·AsyncIterable·동기 반환 | 어댑터에서 Effect와 연결 | 외부 API의 타입과 실행 의미를 유지한다. |

모든 함수를 Effect로 감쌀 필요는 없다. 순수 함수와 외부 API가 요구하는 Promise·generator를 유지하는 것은 전면 전환과 모순되지 않는다. 반면 기존 쿼리 전체를 `Effect.tryPromise`로 감싼 뒤 내부의 분리된 Promise와 취소 처리를 그대로 두는 것은 실행 체계를 교체한 것이 아니다.

Effect를 실행하는 경계는 Pi 진입점과 외부 callback 어댑터로 제한한다. 기능 서비스는 Effect를 조합한다. SDK 소비·도구 전달·요약 작업의 Fiber는 해당 Query Scope 또는 Summary Scope에 귀속한다. 인스턴스 초기화나 세션 이벤트에는 가상의 Query Scope를 만들지 않고 인스턴스 실행 경계를 사용한다.

Promise를 요구하는 MCP handler와 SDK 입력 generator는 예외를 구분한다. 이 어댑터의 `runPromise`는 Scope 밖에서 쿼리 소유 `Deferred`를 기다린다. 정리 시에는 `releasePendingToolCalls`, `end`, `fail`로 대기를 해소해 프로토콜 응답을 돌려주며, handler 자체를 중단해 내부 Fiber 오류로 바꾸지 않는다. 이 경계에서 독립적인 SDK 작업을 시작하지 않는다. 동기 취소 callback의 `QueryExecution.requestStop()`도 제어 진입점이지만, 중단 요청 Fiber는 해당 쿼리 Scope에 연결한다.

### 6.2 오류의 원인과 외부 표현을 구분한다

[Effect 4.0.5의 `tryPromise` 기본형][effect-internal-source]은 실패를 `UnknownError`로 감싸며 `An error occurred in Effect.tryPromise`라는 메시지를 사용한다. 현재 브리지는 [원본 오류의 메시지][source-completion]를 Pi에 전달하는 경로가 있다. 기본 래핑을 그대로 노출하면 외부 오류 표현이 바뀐다.

어댑터는 명시적인 `{ try, catch }` 매핑 등으로 원본 오류를 보존하고, Pi 출력 경계에서 기존 메시지·실패 분류로 변환해야 한다. Effect의 내부 원인 표현을 그대로 사용자 오류로 노출하지 않는다.

| 원인 | 보존할 결과 |
| --- | --- |
| 현재 호출자의 취소 신호 | `aborted`, 대기 해제, 해당 미러의 재구성·UUID 교체 정책 |
| 기록 변경에 따른 쿼리 폐기·교체 | 이전 쿼리를 정리하되 교체 쿼리의 스트림·미러는 변경하지 않음 |
| 일반 SDK·처리 실패 | `error`, 기존 오류 메시지와 cursor·재구성 정책 |
| 기존 동기 준비 경로의 예외 | 동기 throw와 스트림 error 사이의 기존 경계 유지 |

모든 Fiber 중단을 사용자 취소로 분류하면 안 된다. 폐기된 쿼리의 정리는 교체 쿼리에 `aborted`를 발행하는 사건이 아니다. 이 구분은 Scope가 닫힌 사실만이 아니라, 종료 원인과 현재 소유권으로 판단한다.

### 6.3 타입 설정도 이 패키지의 재설계 범위에 포함한다

현재 [`tsconfig.json`][source-tsconfig]은 의도적으로 `strict: false`를 사용한다. 새 구조는 타입 단언과 `any`로 기존 가변 객체를 통과시키는 방식이 아니라, 서비스 요구사항과 상태 전이를 타입으로 표현하는 방향으로 설계한다.

[Effect v4 설치 안내][effect-installation]는 `strict: true`를 설정하도록 안내하며, [Schema][effect-schema]도 이를 요구한다. TypeScript 5.9 이상이라는 조건은 확인한 개발 의존성 6.0.3이 충족한다. `strict: false`이면 Effect가 런타임에서 무조건 실행되지 않는다는 뜻은 아니다.

권장 목표는 `apps/pi-claude-bridge`의 `strict: true` 전환이다. 소스뿐 아니라 같은 tsconfig로 검사하는 보조 코드의 영향도 포함한다. 모노레포 전체 설정 변경으로 확대하지 않으며, 타입 정리를 피하려고 광범위한 단언을 추가하지 않는다. 타입 엄격화와 입력 검증 정책 강화는 별개다. Schema 채택을 이유로 기존 허용 입력이나 설정 처리 방식을 바꾸지 않는다.

요금제 감지 후 모델 정책처럼 실행 중 바뀌는 값은 현재 상태를 제공하는 서비스로 표현한다. Layer를 만들 때 한 번 복사한 설정을 모든 쿼리에 고정하면 기존 갱신 동작을 잃는다.

## 7. 구조 변경으로 바꾸면 안 되는 동작

기존 내부 파일 경로·factory·`__test` API는 새 구조에 맞게 바꿀 수 있다. 반면 기능 보존은 정상 응답만 같다는 뜻이 아니므로, 다음 경계의 입력, 출력, 순서, 실패 처리는 유지해야 한다. 이 표는 특히 회귀 위험이 큰 경계를 정리한 것이며 전체 기능 명세를 대신하지 않는다. 세부 계약은 [패키지의 동작 지침][source-contracts]과 기존 구현을 함께 따른다.

| 경계 | 보존해야 할 동작 |
| --- | --- |
| Pi 공급자 | `streamSimple` 반환 전 동기 준비·활성 등록, 동기 스트림 반환, 공급자 이름·모델 등록, 이벤트 순서, 최종 결과, usage·오류 표현 |
| 프롬프트 | 지침 출처와 상속 관계, 프로젝트·스킬·도구 지침, 해결할 수 없거나 금지된 투영의 실패 처리 |
| 도구 결과 | `claudecode/toolUseId` 기반 매칭, 먼저 도착한 결과 보관, 조정 메시지 쓰기 확인 후 결과 전달. 쓰기 실패 시 재구성을 표시하되 결과는 계속 전달 |
| 취소·폐기 | 현재 호출의 취소 신호, 대기 해제, 늦은 완료의 소유권 검사, 중단된 writer와 충돌하지 않는 UUID 교체 |
| 세션 복원 | Pi 기록을 기준으로 재사용·재구성 판단, 재진입 격리, 이전 파일은 읽기 자료로만 사용, 첨부와 결과 표현 보존 |
| 독립 요약 | `cacheRetention: "none"` 분기, 미러 비사용, 도구·hook 비활성화, `persistSession: false`, `maxTurns: 1`, 호출자의 reasoning·시스템 프롬프트 |
| 모델·SDK 옵션 | context window와 실제 Claude 모델 ID의 일치, thinking 매핑, 자식 환경, hook·도구 제한, `extraArgs` 중복 오류 |
| 설정 | 프로젝트 설정 우선, 기존 필드 보존, 잘못된 JSON 덮어쓰기 방지, 임시 파일과 rename을 통한 저장, 설정 파일 symlink 보존 |
| 저장 결과 | 프로젝트·세션 경계, symlink 검사, 복원 시 읽는 저장 결과 파일의 32 MiB 제한, descriptor 해제 |
| 인스턴스·진단 | 기존 공유 symbol 키, 세션 연결 형식, 등록 소유권, 다른 소비자가 사용하는 로그 접두사 |

설정과 파일 안전성은 [설정 저장 구현][source-config], [저장 결과 읽기][source-carry]에서 확인했다. 세션 재구성은 [기록 동기화][source-sync], 요약과 SDK 옵션은 [독립 요약][source-summary]과 [옵션 조립][source-options]을 근거로 한다.

다음 변경은 리팩터링에 자동으로 포함하지 않는다.

- 실패한 SDK 쿼리에 `retry`를 추가하는 것. 같은 입력의 재전송이 기록이나 외부 작업을 중복시킬 수 있다.
- 새로운 timeout, 큐 크기 제한, 병렬 실행 제한을 추가하는 것. 기존 완료 시간과 도구 실행 순서를 바꾼다.
- Schema 적용을 이유로 허용 입력, 알려지지 않은 설정 필드, 오류 처리 정책을 바꾸는 것.
- 파일 I/O를 비동기로 바꾸면서 같은 세션의 재구성과 쿼리 시작 사이에 새 동시 실행을 허용하는 것.
- 캐시 관련 직렬화 순서, 도구 인자, 공개 로그 표현을 기능과 무관한 정리로 변경하는 것.

Effect 전환이 이런 변경을 쉽게 만들더라도, 동작 변경은 별도의 요구사항으로 판단해야 한다.

## 8. 검토 반영, 비용과 검증 한계

### 8.1 전면 재설계 목표에 맞춰 검토 결과를 반영한다

Opus 5.5(`claude-bridge/claude-opus-5-5`)가 초기 문서를 독립 검토한 뒤, 코드 근거와 공식 Effect 자료를 대조하는 재검토를 수행했다. 핵심 방향은 적합하지만 동기 준비·상태 소유권·오류 의미 등의 보완이 필요하다는 결론이었다.

이후 사용자가 작은 구조부터 시작하지 않고 내부 구조를 전면 재설계하겠다고 명시했다. 이번 문서는 그 방향에 맞춰 검토 결과를 반영했다.

| 검토 의견 | 이번 문서의 처리 |
| --- | --- |
| 반환 전 동기 준비와 실패 경계를 명시해야 한다. | 3.4절과 6.2절에 반영했다. |
| 세션 종료 때 런타임 재생성은 상태와 등록 소유권을 잃을 위험이 있다. | 4.4절에서 인스턴스 런타임 유지로 구체화했다. |
| Query와 Session의 관계, 인스턴스 간 전달이 불명확하다. | Query→Session 단방향 의존과 공유 레지스트리를 거치는 동기 이벤트 흐름으로 정했다. |
| 여러 파일에 쿼리 상태를 나누면 소유권이 분산될 수 있다. | 파일 분리는 허용하되 QueryRun의 생성·교체·종료 소유권은 하나로 정했다. |
| 기존 factory 정리 후 점진 전환하고 임시 호환 facade를 유지하자. | 전환 전략으로 채택하지 않는다. 목표 구조로 교체하며 기존 내부 API 호환은 필수로 두지 않는다. |
| 기존 테스트가 내부 경로와 필드에 결합되어 있다. | 내부 테스트 구성을 재설계하되 기존 동작을 검증하는 기대값은 보존한다. |

Coordinator에서 후속 완료 처리를 수행하는 것도 기술적으로 가능하며, 파일 분리 자체가 상태 소유권 분산을 의미하지도 않는다. 검토에서 이 두 사실은 확인했다. 최종 파일 수나 Coordinator의 존재가 필수라는 합의는 없었다. 이번 권장안은 요청 분기와 세션 이벤트 처리만 app에 두고, 쿼리 완료는 Query 기능이 소유하도록 선택했다.

Opus의 재검토 대상은 수정 전 문서다. 이번 수정본 전체를 Opus가 다시 승인했다고 해석해서는 안 된다.

### 8.2 내부 테스트는 바꿀 수 있지만 기대 동작은 유지한다

전환 전 `unit-*.mjs` 중 `query-context.js`, `tool-bridge.js`, `runtime.js`를 직접 참조하는 파일은 12개다. 그 밖에 `index.js`의 `__test`를 사용하는 테스트도 있다. [일부 테스트][source-querycontext-test]는 `activeQuery` 같은 내부 필드를 직접 설정한다.

전면 재설계에서는 이 import, fixture 주입 방식, 내부 상태 접근을 새 서비스 계약과 테스트용 Layer에 맞게 바꿀 수 있다. 기존 `__test`나 경로를 유지하려고 목표 구조를 왜곡하지 않는다. 다만 다음 구분이 필요하다.

- 내부 접점의 교체: 같은 입력·상황과 기대 결과를 새 구조에서 검사한다.
- 동작 변경: 기존 기대 결과나 순서를 새 구현에 맞춰 바꾼다. 이는 기능 보존 리팩터링으로 간주하지 않는다.

408개라는 테스트 수 자체가 보존 대상은 아니다. 기존 사례가 확인하던 도구 매칭, 동기 등록, 취소 인계, 재구성, 오류 표현을 새 구조에서도 확인하는 것이 기준이다. 기존 fixture와 기록을 이용할 때도 이벤트 순서와 최종 SDK 옵션까지 비교해야 한다. 타입 검사 통과나 최종 텍스트 일치만으로 같은 동작이라고 판정하지 않는다.

### 8.3 추가 비용과 배포 경계를 포함한다

전면 재설계의 비용에는 Effect API와 Fiber·Scope 이해, 외부 SDK 연결, 타입 엄격화, 테스트 재구성, 설치 패키지 검증이 포함된다. 기존 내부 API 호환 계층을 필수로 두지 않는 만큼, 새 구조가 기존 동작을 보존한다는 증거를 확보해야 한다.

기대하는 이점은 의존성을 드러내고 상태 변경 권한과 정리 책임을 제한하는 것이다. 유지보수 시간, 결함 수, 시작 시간, 메모리 사용량, 이벤트 처리 지연이 실제로 개선되었다는 측정 결과는 아직 없다.

현재 패키지는 [TypeScript 소스와 `src/index.ts` 진입점을 배포][source-package]한다. Effect는 운영 의존성으로 선언하고 새 모듈이 배포본에 포함되어 실제로 로드되는지 확인해야 한다. Pi가 제공하는 호스트 패키지를 중복 운영 의존성으로 넣거나, 워크스페이스의 로딩 성공을 설치본의 증거로 대신하지 않는다.

### 8.4 기존 구현에서 확인한 기준선

앞선 분석에서 아래 명령을 `apps/pi-claude-bridge`에서 실행했다. 이번 문서 수정 때문에 다시 실행한 결과는 아니다.

```bash
pnpm typecheck
pnpm test:unit
```

| 항목 | 확인 결과 |
| --- | --- |
| 타입 검사 | 종료 코드 0 |
| 단위 테스트 | 44개 파일, 408개 테스트 통과 |
| 확인한 개발 도구 | pnpm 10.29.2, TypeScript 6.0.3 |
| 설치된 호스트·SDK | Pi coding-agent 1.3.0, pi-ai 1.3.0, Claude Agent SDK 0.3.304 |
| Effect 배포 정보 | 확인 시점의 공식 npm `latest`는 4.0.5 정식 버전 |

Node.js 버전은 실행 환경을 구분해 해석해야 한다. 초기 분석 도구 프로세스에서는 26.3.0을, 후속 CLI 조회에서는 24.14.0을 확인했다. 기존 검증 명령을 실행한 자식 프로세스의 Node.js 버전은 별도로 기록하지 않았으므로 26.3.0에서 테스트했다고 단정하지 않는다.

이 기준선을 측정했을 때는 Effect가 도입되기 전이었다. 위 결과는 기존 구현의 기준선이며 전환 후 검증 결과와 구분해야 한다. 배포 정보는 [npm 레지스트리][effect-registry]와 [Effect 4.0 발표][effect-release]를 확인했다.

### 8.5 설계 시점에 남겨 둔 검증 사항

- 전면 재설계 후 기존 기능과 동작 계약의 보존
- 실제 Claude Code·SDK에서 조정 메시지와 도구 결과가 전달되는 순서
- 캐시 재사용량, 프로세스 재시작 후 재구성 결과, 실제 계정별 모델 정책
- Effect를 추가한 설치 패키지의 로딩과 선언된 최소 Node.js 버전에서의 실행
- 처리 지연, 메모리 사용량, 반복적인 종료·재진입에서의 자원 정리

Opus를 통한 문서 검토는 수행했지만, 브리지 기능을 검증하는 실제 Claude 통합 테스트와 캐시 측정은 실행하지 않았다.

**최종 권고는 기존 내부 구조를 보존하는 작은 변경이 아니라, 목표 구조로 전면 교체하면서 외부 기능 계약을 보존하는 것이다.** Layer는 서비스를 조립하고, QueryRun은 쿼리 상태와 자원을 소유하며, Scope와 Fiber는 그 소유권에 맞춰 실행과 정리를 연결한다.

## 9. 구현 대응과 검증 결과

### 9.1 목표 구조를 실제 실행 경계로 옮겼다

2026-10-22 UTC 기준 작업 브랜치는 `refactor/pi-claude-bridge-effect-v4`다. Effect `4.0.5`를 운영 의존성으로 고정하고, 이 패키지의 TypeScript 설정만 `strict: true`로 전환했다.

| 설계상의 책임 | 실제 구현 |
| --- | --- |
| 서비스 조립과 인스턴스 수명 | [`app/layer.ts`](../src/app/layer.ts)의 `BridgeLive`와 [`app/runtime.ts`](../src/app/runtime.ts)의 `ManagedRuntime` |
| 동기 공급자 진입과 요청 분기 | [`adapters/pi/registration.ts`](../src/adapters/pi/registration.ts), [`app/requests.ts`](../src/app/requests.ts) |
| QueryRun의 상태·실행 소유권 | [`features/query/state.ts`](../src/features/query/state.ts)의 `QueryContext`, [`lifecycle.ts`](../src/features/query/lifecycle.ts)의 `QueryExecution` |
| SDK 소비와 Pi 이벤트 변환 | [`features/query/consume.ts`](../src/features/query/consume.ts), [`adapters/pi/stream-events.ts`](../src/adapters/pi/stream-events.ts) |
| 세션 미러와 기록 변경 이벤트 | [`features/session/mirror-store.ts`](../src/features/session/mirror-store.ts), [`app/session-events.ts`](../src/app/session-events.ts) |
| 도구 대기와 stdin 확인 응답 | [`features/tool-bridge/service.ts`](../src/features/tool-bridge/service.ts), [`adapters/claude/prompt-input.ts`](../src/adapters/claude/prompt-input.ts)의 `Deferred` |
| 독립 요약과 SDK 반복자 정리 | [`features/summary/service.ts`](../src/features/summary/service.ts), [`adapters/claude/messages.ts`](../src/adapters/claude/messages.ts) |
| 검증용 서비스 접근 | [`tools/verify/bridge-runtime.ts`](../tools/verify/bridge-runtime.ts), 운영 진입점의 `__test` 대신 배포에서 제외한 어댑터 사용 |

`QueryExecution`의 Scope는 SDK 쿼리 단위다. Pi 스트림이 도구 호출로 끝났다는 이유로 닫지 않으며, 후속 호출은 같은 실행에 새 출력 스트림과 취소 신호를 연결한다. 쿼리와 요약 Scope는 인스턴스 Layer의 수명 아래에 둔다. 계정 감지는 시작한 쿼리가 끝난 뒤에도 결과를 반영할 수 있도록 인스턴스 수명에 둔다.

종료 결과 발행과 라우팅·취소 연결 해제는 같은 동기 처리 안에서 수행한다. SDK 반복자 정리는 기다릴 수 있으므로, 먼저 prompt/MCP 대기를 해소하고 transport를 닫는다. 늦은 정리는 소유권을 확인하며 새 쿼리의 상태를 해제하지 않는다.

`Deferred`는 완료 시 즉시 소비자를 재개할 수 있다. 기존 Promise 확인 응답의 미세 작업 경계는 성공과 실패 모두에서 유지했다. 이 경계를 없애면 취소 중 조정 메시지의 확인 응답이 실패할 때, 도구 대기자에 취소 응답보다 정상 결과가 먼저 전달될 수 있었다.

### 9.2 실행 재설계 단계의 검증과 한계

아래 검증은 타입 분리 전 실행 재설계 단계에 `apps/pi-claude-bridge`에서 수행했다. 테스트의 기존 기능 기대값은 유지하고, 내부 import와 대체 객체를 새 접점으로 옮겼다. 이후 타입 분리의 결과는 9.4절에 구분한다.

| 검증 | 결과 |
| --- | --- |
| `pnpm typecheck` | 통과, `strict: true` |
| `pnpm test:unit --testTimeout=15000 --hookTimeout=15000` | 45개 파일, 420개 테스트 통과 |
| `pnpm verify --all` | 오프라인·가짜 실행 파일 검사 13건 통과, live 검사 9건 건너뜀, 실제 API 호출 0건 |
| 소스 로딩·리소스 선택·아카이브 검사 | 저장소의 `tests/fixtures/package-inventory.json`에 선언한 52개 필수 파일을 Pi 1.3.0에서 확인하고 통과 |
| 아카이브 독립 설치 후 로딩·리소스 선택 | README의 `pnpm pack` 절차로 만든 배포본을 별도 npm 프로젝트에 설치하고, 같은 목록으로 Pi 1.4.0에서 확인해 통과 |
| 설치본과 작업 소스 대조 | `src` 48개 파일의 바이트가 모두 일치, `tests/`·`tools/`·`diag/` 미포함 |

실행한 Node.js는 24.14.0이다. 작업 공간 검증의 Claude Agent SDK는 0.3.304이고, 최종 독립 설치에서는 기존 `^0.3.304` 범위가 0.3.309를 선택했다. 독립 설치 검사는 이 SDK 버전의 실제 모델 동작까지 검증한 것이 아니다.

추가한 [수명 테스트](../tests/unit-effect-lifecycle.mjs)는 인스턴스별 서비스 격리, 동기 설정 실패의 원본 오류, 도구 호출 사이의 Scope 유지와 취소 신호 인계, 대기 중 반복자 정리, 쿼리 종료 후 계정 감지를 확인한다. 취소 신호 인계는 사전 취소 여부와 조정 메시지 유무를 조합해 실제 공급자 경로와 MCP 응답까지 검사한다. 기존 쿼리 예외·폐기·세션 종료 테스트에는 최종 오류 메시지, 실행 소유자 판정, 실제 공급자를 통한 교체 경로를 보강했다.

실제 Claude 요청, 실제 stdin·MCP 전달 순서, 캐시 재사용량, 계정별 실제 모델 정책, 성능·메모리 측정, 최소 지원 Node.js 22.19.0에서의 실행은 확인하지 않았다. 따라서 이 결과를 모든 운영 환경에서 기능 보존이 완전히 입증되었다는 뜻으로 확대하지 않는다.

### 9.3 독립 검토와 수정 결과

Opus 5.5 검토자 두 개가 서로 독립된 문맥에서 실행·수명과 기능 보존·배포 구성을 나누어 검토했다. 검토자는 셸 도구가 없어 정적 분석만 수행했다. 아래 재현과 수정 후 검증은 구현 담당 세션에서 실행했으며, 독립 검토자가 수정본을 다시 실행해 승인한 결과로 표현하지 않는다.

| 확인 사항 | 처리와 근거 |
| --- | --- |
| 이미 취소된 새 신호로 도구 결과를 이어받으면 내부 오류를 동기 throw | 두 사례로 재현했다. 신호 연결 전에 실행 소유자를 확보하고, 취소로 닫히는 Scope에는 전달을 시작하지 않는다. 반환 스트림의 `aborted`·`Operation aborted`, MCP 응답, 빈 대기 큐를 확인했다. |
| 실행 소유자가 없거나 활성 핸들과 맞지 않는 문맥도 라우팅 가능 | 활성 상태와 SDK 핸들이 일치하는 소유자만 선택한다. 폐기도 같은 소유자를 통해 수행하며, 소유자 없는 Promise 중단 우회 경로를 제거했다. 네 가지 부적합 소유자 사례를 검사한다. |
| 종료된 인스턴스에서 쿼리 폐기·교체 중 알림 연결이 사라질 가능성 | 기존 대체 객체 대신 실제 공급자로 대기 쿼리를 만들어 재현했다. `registerActiveQuery`가 새 소유자를 등록할 때 알림 연결도 복구한다. 교체 중 연결 유지와 마지막 종료 후 해제를 확인했다. |
| 저장소의 패키지 목록이 삭제된 경로 38개를 요구 | 현재 소스 48개와 패키지 메타데이터 4개로 갱신했다. 임시 축약 목록 대신 저장소 목록으로 소스·아카이브·독립 설치본 검사를 통과했다. |
| 낡은 안내 경로와 callback Scope 설명 | 경로를 갱신하고, 운영 진단 서비스와 `diag/`를 구분했다. MCP·generator의 Promise 경계와 쿼리 소유 대기 해제는 6.1절에 명시했다. |

운영 진입점이 단위 테스트에서 실행되지 않는다는 의견은 채택하지 않았다. [공급자 등록 테스트](../tests/unit-provider-registration.mjs)가 `src/index.ts`를 직접 가져와 최초 등록과 다른 인스턴스의 등록 경계를 검사한다. 장기 Fiber가 동기 스케줄러를 상속하는 점은 현재 I/O 대기를 사용하는 실행 경계의 주석으로 남겼고, 검증되지 않은 스케줄링 변경은 하지 않았다.

검토자가 이전 소비 루프의 끝부분을 충분히 읽지 못한 한계는 구현 담당 세션에서 기준 커밋의 `consumeQuery` 전체와 현재 구현을 추가 대조해 보완했다. 위 수정 후 타입 검사·420개 단위 테스트·오프라인 검사·패키지 검증을 다시 수행했다. 실제 Claude 동작과 성능에 관한 9.2절의 한계는 그대로 남는다.

### 9.4 타입과 구현의 추가 분리

공유 데이터 타입, 서비스 계약, 생성 함수의 의존성 타입을 기능·어댑터별 `types.ts` 11개로 옮겼다. 공용 타입 59개를 이동하고, 긴 인라인 생성 의존성 12개에 이름을 붙였다. 하나의 전역 타입 모듈로 합치지 않는다.

- [쿼리 타입](../src/features/query/types.ts): 실행 상태, 도구 대기, 서비스 계약과 생성 의존성
- [세션 타입](../src/features/session/types.ts): 미러, 기록 연결, 복원 데이터와 동기화 계약
- [Claude 어댑터 타입](../src/adapters/claude/types.ts)과 [Pi 어댑터 타입](../src/adapters/pi/types.ts): 외부 연동의 입력·출력과 서비스 계약
- [설정 타입](../src/configuration/types.ts): 저장소 어댑터와 설정 서비스가 함께 사용하는 설정 구조
- 나머지 `app`, 진단, 모델, 프롬프트, 요약, 도구 전달 타입도 각 소유 디렉터리에 둔다.

사용하는 쪽은 새 타입 모듈을 `import type`으로 참조한다. `Context.Service` 태그, `Layer`, `QueryContext`, `QueryExecution`, `PromptCaptures` 등 실행 코드가 있는 클래스는 구현 파일에 남긴다. 구현 안에서만 쓰는 작은 별칭도 옮기지 않는다. 세션 저장소와 인스턴스 레지스트리의 계약은 factory의 반환값 추론 대신 명시적 인터페이스로 정의했으며, 기존 필드·메서드·읽기 전용 범위는 유지했다.

이 단계에서는 제어 흐름과 테스트 사례를 변경하지 않았다. TypeScript 6.0.3으로 주석과 타입을 제거해 비교한 기존 구현 48개 파일의 JavaScript는 모두 동일했다. 새 타입 모듈 11개에도 실행문이 없음을 확인했다. 이 비교는 실행 코드의 동일성을 확인하는 것이며 실제 Claude 동작 검증을 대신하지 않는다.

| 타입 분리 후 검증 | 결과 |
| --- | --- |
| `pnpm typecheck` | 통과 |
| `pnpm test:unit --testTimeout=15000 --hookTimeout=15000` | 45개 파일, 420개 테스트 통과 |
| 저장소 목록 기준 소스 로딩·아카이브 검사 | Pi 1.3.0에서 통과, 타입 파일을 포함한 63개 필수 파일 확인 |
| 캐시를 이용한 오프라인 설치 후 로딩 | Pi 1.4.0에서 통과, 설치본의 소스 59개가 작업 파일과 모두 일치 |

실행 환경은 Node.js 24.14.0이며, 설치본의 Effect는 4.0.5, Claude Agent SDK는 0.3.309다. 9.3절의 독립 검토는 타입 분리 전 구현을 대상으로 했으며 이번 단계에서 재수행하지 않았다. 이 단계까지는 실제 Claude 통합·캐시·최소 Node 버전 실행을 확인하지 않았다. 이후 Haiku 실검증은 다음 절에 구분한다.

### 9.5 Haiku 실제 요청 51회와 후속 진단 수정

2026-10-23 UTC, 사용자가 승인한 Haiku 실검증에서 **실제 모델 요청 51회와 정상 응답 51회**를 확인했다. 정상 응답에는 도구 호출 응답도 포함한다. 이미 취소된 신호로 도구 결과를 인계한 1회는 API 요청 없이 `aborted`로 끝났으며 별도로 집계했다. 하나의 연속 실행이나 최종 코드만의 51회가 아니라, 진단 수정 전 41회와 수정 후 10회를 합한 결과다.

모델은 `claude-haiku-5-5`, SDK의 선택 값은 `claude-haiku-5-5[1m]`으로 제한했다. 기존 live 검증 장치가 API 키와 다른 모델 요청을 차단하고 구독 인증 경로를 확인했다. 실행 환경은 Node.js 24.14.0, Effect 4.0.5, Claude Agent SDK 0.3.304, Claude Code 2.1.304다. 직접 공급자 검증에는 작업 공간의 Pi 1.3.0 라이브러리를, 실제 RPC 프로세스에는 Pi 1.4.0을 사용했다. 청구 내역이나 실제 과금액은 조회하지 않았다.

| 실행 | 정상 응답 / 실제 모델 요청 | 판정과 후속 처리 |
| --- | --- | --- |
| 첫 실행 | 41 / 41 | 기억 유지, 병렬·역순 결과, 조정 메시지, 빈 결과·오류·이미지·90KiB 결과, 결과 표현 복원, 취소 후 회복, 독립 요약을 확인했다. 이전 user/assistant 기록이 없는 입력에도 UUID 유지를 요구한 임시 검증의 잘못된 가정으로 마지막 판정이 중단됐다. 이 입력은 기존 계약상 clean start다. |
| 진단 수정 후 보완 | 7 / 7 | 병렬 결과 역순 전달, 독립 요약, 이전 기록을 남긴 축약 문맥의 동일 UUID 재구성과 기억 유지를 확인했다. 이후 기준선 없는 프로세스 집계가 잔여 1개를 보고했다. 그 실행에서는 해당 프로세스의 실행 파일 이름을 기록하지 않았다. |
| 최종 확인 | 3 / 3 | 모델 호출 전부터 존재하는 `esbuild`를 기준선으로 식별했다. 실제 요약 1회와 Pi 프로세스 2회의 재시작 검증을 마친 뒤 새 SDK/Pi 하위 프로세스가 남지 않았고, 검증 실행기도 정상 종료했다. |

실검증에서 발견한 운영 코드 문제는 병렬 대기열의 **진단 오탐**이었다. 서로 다른 도구 ID가 `pendingToolCalls`와 `pendingResults`에 각각 대기할 수 있는데도, 두 Map이 모두 비어 있지 않으면 `BUG:`를 기록했다. 첫 실행에서 두 번 관측했지만 결과는 올바른 도구에 전달됐다. [도구 전달 서비스](../src/features/tool-bridge/service.ts)를 같은 ID가 두 Map에 함께 있을 때만 오류를 기록하도록 수정했다. 결과 전달 방식과 기존 진단 접두사는 유지했다. [회귀 테스트](../tests/unit-queue.mjs)를 추가했고, 보완 실행에서도 결과가 먼저 대기열에 들어갔다가 해당 MCP handler에 전달되는 경로와 `BUG:` 0건을 확인했다.

수정 후 `apps/pi-claude-bridge`에서 다음 검증을 실행했다. 타입 검사와 4개 파일의 관련 테스트 31개가 통과했다. 전체 단위 테스트와 설치 아카이브는 이 진단 수정 후 다시 실행하지 않았다.

```bash
pnpm typecheck
pnpm test:unit tests/unit-queue.mjs tests/unit-deliver-tool-results.mjs tests/unit-deadlock-log-gate.mjs tests/unit-effect-lifecycle.mjs --testTimeout=15000 --hookTimeout=15000
```

실제 Pi 재시작에서는 같은 Pi 세션을 이어받으면서 Claude UUID는 새로 만들고 이전 Claude 파일은 변경하지 않았다. 기록 연결 수는 첫 프로세스에서 `0→1`, 두 번째에서 `1→2`였으며, 연결 메타데이터는 모델 문맥에 들어가지 않았다. 정규화한 기존 요청 요소 5개는 모두 보존됐다. 다만 원래 표현을 그대로 비교하면 시스템 메시지 하나가 text block 배열에서 문자열로 달라졌다. 이전 캐시 가능 입력 13,279토큰 중 12,937토큰을 읽어 **342토큰의 캐시 재사용 부족**을 관측했다. 내용 보존과 완전한 캐시 보존을 같은 결과로 취급하지 않으며, 이전 구현과 비교하지 않았으므로 이 차이를 Effect 재설계의 회귀로 단정하지 않는다.

집계 보고서는 `/tmp/pi-claude-bridge-haiku-50.DhM1Bx/summary.json`에 보관했다. 같은 디렉터리의 `report.json`, `follow-up/report.json`, `final-check/report.json`에는 원래 실행 상태를 유지했다. 앞선 두 보고서의 실패 상태를 덮어써 성공으로 바꾸지 않았다.

이번 검증은 실제 stdin·MCP 왕복과 도구 경계의 취소·복구를 포함하지만, 캡처 프록시가 upstream SSE 응답을 버퍼링한다. 따라서 실제 토큰 간 지연과 네트워크 스트리밍 도중 취소의 시간 동작을 검증한 결과는 아니다. 다른 모델·계정 정책, 최소 Node.js 22.19.0 실행, 재설계 전후 성능·메모리 비교, 캐시 차이의 원인 규명도 남아 있다.

[source-runtime]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/runtime.ts#L19-L50
[source-mirror]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/session/mirror-store.ts#L45-L159
[source-registry]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/provider/query-context.ts#L134-L232
[source-stream]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/provider/stream.ts#L39-L310
[source-query-context]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/provider/query-context.ts#L21-L113
[source-completion]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/provider/completion.ts#L54-L250
[source-prompt-input]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/prompt-stream.ts#L1-L90
[source-tool-bridge]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/provider/tool-bridge.ts#L112-L224
[source-registration]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/provider/registration.ts#L24-L265
[source-tsconfig]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/tsconfig.json
[source-config]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/config.ts#L37-L142
[source-carry]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/session/tool-result-carry.ts#L47-L83
[source-sync]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/session/sync.ts
[source-summary]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/summary/isolated.ts
[source-options]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/cc/query-options.ts
[source-contracts]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/AGENTS.md
[source-package]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/package.json
[effect-layers]: https://effect.website/docs/v4/requirements-management/layers
[effect-runtime]: https://effect.website/docs/v4/runtime
[effect-scope]: https://effect.website/docs/v4/resource-management/scope
[effect-schema]: https://effect.website/docs/v4/schema/introduction
[effect-registry]: https://registry.npmjs.org/effect/latest
[effect-release]: https://effect.website/blog/releases/effect/40
[source-querycontext-test]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/tests/unit-querycontext.mjs#L15-L157
[source-query-routing]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/provider/query-context.ts#L254-L264
[source-plan-detection]: https://github.com/buYoung/pi-packages/blob/bdb11fb46bebe4ac130f3be9c982741ba77e1265/apps/pi-claude-bridge/src/provider/plan-detection.ts#L21-L80
[effect-managed-source]: https://unpkg.com/effect@4.0.5/src/ManagedRuntime.ts
[effect-internal-source]: https://unpkg.com/effect@4.0.5/src/internal/effect.ts
[effect-installation]: https://effect.website/docs/v4/getting-started/installation
