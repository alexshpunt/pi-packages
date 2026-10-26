# @buyong/pi-codex-memory

[English](README.md) | **한국어**

Codex memory v2를 Pi에 접목한 확장입니다. 대화에서 프로젝트의 결정과 맥락을 추출·통합하고, 새 세션에서 필요한 이력을 조회합니다. 관리는 **`/codex-memory`**에서 합니다.

[검증·성능 결과](docs/verification.ko.md)

## 요구 사항

| 항목 | 요구 사항 |
| --- | --- |
| Pi | 1.4.0 이상 |
| Node.js | 22.19 이상 |
| 기억 생성용 모델 | 자동 생성을 켜기 전에 Pi에서 사용할 공급자를 설정 |

Codex CLI는 설치하지 않아도 됩니다.

## 소스에서 시작

저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter "@buyong/pi-codex-memory..." build
pi -ne -e ./apps/pi-codex-memory
```

계속 사용하려면 `pi install ./apps/pi-codex-memory`로 등록합니다. `pi remove ./apps/pi-codex-memory`로 등록을 제거해도 저장된 기억은 남습니다.

`@buyong/pi-codex` 번들에도 포함됩니다. 번들과 개별 패키지 중 하나만 활성화하세요. 구성 요소를 수정했다면 번들도 다시 빌드해야 합니다.

## 처음 사용하기

### 노트 저장

1. `/codex-memory` → **기억 추가**를 엽니다.
2. 프로젝트의 사실이나 결정을 입력하고 확인합니다.
3. **기억 조회·정정·잊기**에서 읽거나 수정·삭제합니다.

이 관리 작업은 모델을 호출하지 않습니다. `/codex-memory status`에서 현재 범위, 저장 위치, 사용량을 확인할 수 있습니다.

### 자동 생성 켜기

**자동 생성은 기본으로 꺼져 있습니다.** 기존 기억의 조회와 문맥 주입은 사용할 수 있습니다.

1. `/codex-memory settings`를 엽니다.
2. 추출 모델과 통합 모델을 선택하고, 한도를 검토한 뒤 생성을 켭니다.
3. 저장하고 전송 범위를 확인합니다.
4. 현재 분기를 바로 처리하려면 `/codex-memory extract`를 실행하거나, 유휴 조건을 충족할 때까지 기다립니다.

생성은 마스킹한 대화 사본을 선택한 공급자에게 보내며 요금이나 요청 한도를 사용할 수 있습니다. 마스킹이 모든 개인정보를 찾는 것은 아닙니다. 모델에 필요한 공급자 확장도 로드해야 합니다. 현재 대화 모델을 바꿔도 저장한 메모리 모델 선택은 바뀌지 않습니다.

생성은 Pi가 실행 중일 때만 동작하며 전경 작업이 시작되면 취소합니다. Pi 종료 뒤 계속 실행되는 서비스는 아닙니다.

## 명령과 도구

| 명령 | 동작 |
| --- | --- |
| `/codex-memory` | 기억·설정·범위·초기화 관리 |
| `/codex-memory status` | 모델 호출 없이 상태 확인 |
| `/codex-memory settings` | 설정 편집·확인 |
| `/codex-memory extract` | 확인 후 현재 분기 추출 |
| `/codex-memory run` | 확인 후 유휴 조건을 충족한 대화에서 기억 추출 |
| `/codex-memory import` | 확인 후 이전 대화도 유휴 세션 검사에 포함 |
| `/codex-memory cancel` | 이 세션의 메모리 작업 취소 |
| `/codex-memory repositories` | 저장소 등록·읽기 연결 관리 |
| `/codex-memory legacy` | 기존 cwd 기억을 선택·확인하여 복사 |

에이전트는 `pi_codex_memory_list`, `pi_codex_memory_search`, `pi_codex_memory_read`, `pi_codex_memory_note`를 사용합니다. 노트 저장에는 확인이 필요합니다. 대화형 관리는 TUI와 UI를 제공하는 RPC에서 지원하며, 비대화형 실행은 변경·전송을 자동 승인하지 않습니다.

## 공유와 범위

한 Git 저장소의 본 작업 폴더, 하위 폴더, 연결된 worktree는 기억·설정·호출 예산을 공유합니다. 별도 clone, 중첩 저장소, 서브모듈은 분리합니다. Git 밖에서는 현재 작업 폴더가 범위입니다.

범위는 원격 URL이 아닌 로컬 Git common directory 경로로 구분합니다. 이 경로를 옮기면 범위가 바뀔 수 있고, 같은 경로에 저장소를 교체하면 이전 범위를 재사용할 수 있습니다.

다른 저장소의 이력을 읽으려면:

1. `/codex-memory repositories`에서 대상 작업 폴더 경로를 등록합니다.
2. 그 저장소의 기억을 명시적으로 조회하도록 요청합니다. 조회 도구의 `repository`에는 등록된 이름, scope ID 또는 경로를 지정할 수 있습니다.
3. 해당 사용자 요청의 접근을 확인하거나, 반복 사용을 위해 단방향 읽기 연결을 저장합니다.

`shop-web → shop-api` 연결이 반대 방향의 권한까지 주지는 않습니다. 읽었다고 상대 저장소의 기억을 자동 주입·복사·수정하지 않습니다. 노트·정정·잊기는 현재 활성 범위에만 적용합니다.

기존 cwd 기억은 자동 이전하지 않습니다. `/codex-memory legacy`에서 같은 저장소의 기록을 선택하고 복사를 확인하세요. 잊은 기록은 되살리지 않으며 설정과 생성 동의는 옮기지 않습니다. 복사 후 두 기록은 독립적으로 관리합니다. 개인 전역 범위도 별도로 선택하며, 범위를 바꿔도 기존 기록을 자동 합치지 않습니다.

## 저장과 보존

기억은 프로젝트나 `.git` 안이 아니라 Pi의 중앙 저장 위치에 둡니다.

```text
~/.pi/agent/pi-codex-memory/
├─ state.sqlite
└─ scopes/
   ├─ <shop-api의 scope ID>/
   │  ├─ memory_summary.md
   │  ├─ rollout_summaries/
   │  └─ extensions/ad_hoc/notes/
   └─ <shop-web의 scope ID>/
```

`PI_CODING_AGENT_DIR`로 agent 디렉터리를 바꿀 수 있습니다. 실제 scope ID는 `/codex-memory status`에서 확인합니다. SQLite가 원본이므로 생성된 Markdown을 직접 편집하지 말고 `/codex-memory`로 관리하세요.

| 설정 | 기본값 |
| --- | --- |
| 추출 전 최소 유휴 시간 | 30분 |
| 통합 대기 간격 | 60분 |
| 회당 자료 / UTC 날짜별 모델 호출 | 2개 / 24회 |
| 추출 대상 최대 나이 | 10일 |
| 미사용·고정하지 않은 기억 보존 | 30일 |
| 모델 입력 / 문맥 주입 상한 | 256 KiB / 12 KiB |

명시적 만료는 고정한 기록에도 적용됩니다. 정리는 Pi가 실행 중일 때 수행합니다. 조정 가능한 기본값이며 보편적인 최적값은 아닙니다. 설정 근거는 [시간 설정 설명](docs/timing.ko.md)을 참고하세요.

## 기억이 보장하지 않는 것

- 기억은 과거 근거입니다. 현재 코드의 상태나 작업 실행 권한을 증명하지 않습니다.
- 잊기는 활성 기억을 지우고 해당 출처의 재생성을 막습니다. 원본 세션·과거 응답·백업·공급자 사본까지 지우지는 않으며, 독립된 출처에 같은 사실이 있을 수 있습니다.
- 기억을 읽거나 인용을 검증했다고 답변이 항상 맞는 것은 아닙니다. 확인한 정확도·토큰 사용량과 한계는 [검증 결과](docs/verification.ko.md)에 정리했습니다.

## 검증

저장소 루트에서 실행합니다.

```sh
pnpm --filter "@buyong/pi-codex-memory..." build
pnpm --filter @buyong/pi-codex-memory typecheck
pnpm --filter @buyong/pi-codex-memory test
pnpm --filter @buyong/pi-codex-memory benchmark
node scripts/codex/check-package.mjs apps/pi-codex-memory
```

테스트는 격리된 저장소와 가짜 모델 스트림을 사용합니다. `benchmark`는 합성 스케줄링 데이터이며 실모델 성능 측정이 아닙니다. 위 명령은 실모델 메모리 응답을 요청하지 않습니다.

[Codex memory v2](https://github.com/openai/codex/tree/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/memories)를 Pi의 공급자·SQLite 저장 방식에 맞게 적용했으며 Codex DB를 공유하지 않습니다. [Apache-2.0](LICENSE). 출처는 [NOTICE](NOTICE)를 참고하세요.
