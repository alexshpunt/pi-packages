# @buyong/pi-codex-memory

[English](README.md) | **한국어**

Pi 대화에서 프로젝트의 결정과 맥락을 기억으로 남기고 다음 세션에서 꺼내 쓰는 확장입니다. 한 프로젝트를 여러 세션에 걸쳐 작업하는 Pi 사용자를 위한 것입니다. 오늘 "배포 게이트를 `amber`로 바꾼다"고 정했다면, 며칠 뒤 새 세션에서 "배포 게이트 뭐로 정했지?"라고 물을 때 에이전트가 기억을 읽고 출처를 인용해 답합니다.

[Codex memory v2](https://github.com/openai/codex/tree/4610b573e59b211bf9430cf6ffb97cfb84623090/codex-rs/memories)의 추출·통합 방식을 Pi의 모델 공급자와 SQLite 저장소에 맞게 옮겼습니다. Codex CLI는 필요 없고 Codex의 데이터베이스도 쓰지 않습니다.

## 요구 사항

| 항목 | 조건 |
| --- | --- |
| Pi | 1.4.0 이상 |
| Node.js | 22.19 이상 |
| pnpm | 10. 소스에서 빌드할 때 씁니다. |
| 기억 생성 모델 | Pi에서 쓸 수 있는 모델. 기억을 만들 때만 필요합니다. |

## 설치

아직 npm에 게시하지 않았으므로 저장소 소스에서 빌드해 Pi에 등록합니다.

```sh
git clone https://github.com/buYoung/pi-packages.git
cd pi-packages
pnpm install
pnpm --filter "@buyong/pi-codex-memory..." build
pi install ./apps/pi-codex-memory
```

설치한 뒤 Pi를 시작하면 `/codex-memory` 명령들을 쓸 수 있습니다. `pi remove ./apps/pi-codex-memory`로 등록을 지워도 저장된 기억은 남습니다.

저장소 소스로 빌드한 `@buyong/pi-codex` 번들에도 이 확장이 들어 있습니다. npm에 게시된 번들에는 아직 없습니다. 번들과 이 패키지를 함께 켜면 안 됩니다.

## 빠른 시작

검증에 쓴 설정으로 기억을 만들고 새 세션에서 꺼내 봅니다. 기억 생성 모델은 `claude-bridge/claude-haiku-5-5`이고 시간 설정은 기본값입니다. `claude-bridge` 공급자는 [@buyong/pi-claude-bridge](https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/README.ko.md) 확장이 제공하므로 그 안내에 따라 먼저 설치해 두어야 합니다. Pi에 이미 설정해 둔 다른 모델을 골라도 됩니다.

기억을 만들면 대화 사본을 마스킹해 고른 모델에 보내므로 그만큼 요금이나 사용 한도를 씁니다. 마스킹이 모든 개인정보를 찾아내지는 못합니다.

Pi의 화면이 영어이므로 아래에서 굵게 표시한 메뉴 이름은 화면에 보이는 그대로 적었습니다.

### 1. 기억 만들기 켜기

1. 기억을 쓸 프로젝트 폴더에서 Pi를 시작하고 `/codex-memory`를 실행합니다.
2. **Use and create memories**를 고릅니다.
3. `claude-bridge/claude-haiku-5-5`를 고릅니다. 추출과 통합에 모두 쓰며 추론 강도는 추출에 `low`, 통합에 `medium`을 씁니다.
4. 모델과 하루 호출 한도를 보여 주는 **Send conversations to create memories?** 확인 창에서 허용합니다.

"Memory creation is on. A conversation becomes memory after 30 idle minutes." 알림이 뜨면 켜진 것입니다.

### 2. 결정을 기억으로 만들기

1. 대화에서 결정을 남깁니다. 예: `배포 게이트는 amber로 바꾸기로 했어. 이 프로젝트에만 적용해.`
2. `/codex-memory-manage`를 실행하고 **Generate from this conversation**을 고른 뒤 허용합니다. 이 항목은 기억 만들기가 켜져 있을 때만 보이며, 30분을 기다리지 않고 지금 기억을 만듭니다.
3. 끝나면 "Created memories from 1 conversation(s)." 알림이 뜹니다.
4. `/codex-memory-manage`에서 **Review saved memories**를 고르면 저장된 기억이 보입니다.

### 3. 새 세션에서 꺼내 쓰기

1. 같은 프로젝트에서 `/new`로 새 세션을 엽니다.
2. `배포 게이트 뭐로 정했지?`라고 묻습니다.

에이전트는 요청마다 함께 전달되는 기억 요약을 보고, 더 필요하면 기억을 검색하고 읽습니다. 기억을 썼다면 `amber`라고 답하고 답 끝에 출처를 인용하며, 상태 표시줄에 인용이 표시됩니다.

```text
Memory: Use and create · 1 cited
```

상태 표시줄은 현재 모드로 시작합니다. `1 cited`는 마지막 답이 에이전트가 실제로 읽은 기억을 인용했을 때만 나타나고, 읽은 내용과 맞지 않는 인용은 경고 알림으로 알려 줍니다. `updating…`은 기억 작업이 진행 중이라는 뜻이고 `update failed`는 마지막 작업이 실패했다는 뜻입니다.

기억은 과거 대화의 기록입니다. 지금 코드도 그 상태라는 보장은 없으니 중요한 내용은 코드에서 다시 확인하세요.

## 평소에 쓰는 방식

**Use and create memories** 모드에서는 Pi가 열려 있는 동안 기억이 백그라운드에서 만들어집니다. Pi를 닫아 둔 동안에는 처리하지 않고, 기다리던 대화는 다음에 Pi를 열어 쉬고 있을 때 처리합니다.

- 대화가 30분 동안 멈추면 그 대화에서 기억을 추출합니다.
- 추출한 내용은 최대 60분에 한 번 기존 기억과 통합합니다.
- 새로 입력하면 진행 중인 기억 작업을 취소합니다.

무언가를 바로 남기려면 에이전트에게 "기억해 줘"라고 요청합니다. 저장하기 전에 저장할 문장을 그대로 보여 주는 확인 창이 뜨며, **Use saved memories** 모드에서도 됩니다. 대화 전체를 남기려면 `/codex-memory-manage`의 **Generate from this conversation**을 씁니다.

### 틀린 기억 고치기

`/codex-memory-manage`에서 **Review saved memories**를 고릅니다. **Search…**로 목록을 좁히고 기억을 고른 뒤 **View memory and source**, **Edit memory**, **Forget memory** 중 하나를 고릅니다. 이 작업은 모델을 호출하지 않습니다.

- 고치거나 잊은 기억은 바로 요약과 검색 결과에서 빠집니다.
- 잊은 기억은 같은 대화에서 다시 만들어지지 않습니다. 원본 세션, 공급자 쪽 사본, 같은 사실이 담긴 다른 대화는 지우지 않습니다.

## 명령

세 명령 모두 인자를 받지 않습니다.

| 명령 | 여는 화면 |
| --- | --- |
| `/codex-memory` | 모드: **Off**, **Use saved memories**, **Use and create memories** |
| `/codex-memory-manage` | 저장된 기억: **Review saved memories**, **Generate from this conversation**, 작업 중에만 보이는 **Stop current job**, 실패 뒤에만 보이는 **Show what failed**, **Forget all memories in this scope** |
| `/codex-memory-settings` | 모델, 시간, 보존 기간, 하루 호출 한도, 기억 범위, 저장소 접근 |

화면을 열어도 진행 중인 작업은 멈추지 않습니다. UI가 없는 실행에서는 `/codex-memory`와 `/codex-memory-manage`가 상태를 JSON으로, `/codex-memory-settings`가 설정을 출력하며 아무것도 바꾸지 않습니다.

에이전트는 `pi_codex_memory_list`, `pi_codex_memory_search`, `pi_codex_memory_read`로 기억을 읽고, 기억해 달라고 요청한 내용은 `pi_codex_memory_note`로 저장합니다.

## 기억을 공유하는 범위

같은 Git 저장소의 하위 폴더와 worktree는 기억, 설정, 하루 호출 한도를 함께 씁니다. 따로 clone한 저장소, 중첩 저장소, 서브모듈은 각각 따로 씁니다. Git 밖에서는 폴더마다 따로 씁니다. 설정도 범위마다 따로이므로 다른 저장소에서는 기억 만들기를 다시 켜야 합니다.

범위는 저장소의 로컬 경로로 구분합니다. 저장소 폴더를 옮기면 기존 기억과 연결이 끊기고, 같은 경로에 다른 저장소를 두면 이전 기억을 이어받습니다.

여러 폴더에서 하나의 기억을 쓰려면 `/codex-memory-settings`에서 **Memory scope**를 고르고 **Personal**을 고릅니다. Personal로 정한 폴더는 모두 그 기억과 설정을 함께 씁니다. 범위를 바꿔도 기존 기억은 복사하거나 합치지 않습니다.

이 저장소의 폴더에 저장소 공유 기능 이전에 저장한 기억이 있으면 `/codex-memory-manage`에 **Import N old memories for this folder**가 보입니다. 목록을 보여 준 뒤 그 기억을 저장소 기억으로 복사합니다.

### 다른 저장소의 기억 읽기

`shop-web`에서 작업하면서 `shop-api`에서 정한 내용을 확인하는 예입니다.

1. `shop-web`에서 `/codex-memory-settings`를 실행하고 **Repository access**를 고릅니다.
2. `shop-api`를 고릅니다. 이 확장을 설치한 뒤 `shop-api`에서 Pi를 연 적이 없으면 목록에 없으므로 **Add repository…**에서 폴더 경로를 입력합니다.
3. 에이전트가 묻지 않고 읽게 하려면 **Always allow reads**를, 읽을 때마다 확인하려면 **Ask each time**을 고르고 허용합니다.
4. 에이전트에게 "shop-api 기억에서 인증 방식 찾아 줘"처럼 저장소를 지정해 요청합니다. **Ask each time**을 골랐다면 이때 확인 창이 뜹니다.

접근은 한 방향입니다. `shop-web`이 `shop-api`를 읽게 해도 `shop-api`가 `shop-web`을 읽을 수는 없습니다. 다른 저장소의 기억은 읽기만 하고 요약에 넣거나 복사·수정하지 않습니다.

## 저장 위치와 기본값

기억은 프로젝트가 아니라 `~/.pi/agent/pi-codex-memory/`에 저장합니다. `PI_CODING_AGENT_DIR`을 설정하면 그 아래에 저장합니다. 원본은 `state.sqlite`이고 `scopes/` 아래 Markdown 파일은 여기서 만든 사본입니다. Markdown을 직접 고치지 말고 `/codex-memory-manage`로 관리하세요.

설정은 `/codex-memory-settings`에서 바꿉니다. 바꾼 값은 현재 범위에 바로 저장되고, 진행 중인 기억 작업을 멈추며, 다음 작업부터 적용됩니다. 추출·통합 모델을 따로 정하거나 추론 강도를 바꾸는 등 나머지 설정은 **Edit all settings as JSON**에서 바꿉니다.

| 설정 | 기본값 |
| --- | --- |
| 기억을 만들기 전 유휴 시간 | 30분 |
| 통합 간격 | 60분 |
| UTC 기준 하루 모델 호출 | 24회 |
| 쓰지 않은 기억 보존 | 30일. 에이전트에게 저장을 요청한 기억과 직접 고친 기억은 남깁니다. |
| 한 번에 추출하는 대화 | 2개 |
| 추출 대상 대화의 최대 나이 | 10일 |
| 호출당 입력 / 요약 주입 상한 | 256 KiB / 12 KiB |

30분과 60분을 정한 근거와 조정 기준은 [검증 결과](docs/verification.ko.md#기본-대기-시간을-정한-방법)에 있습니다.

## 검증

코드를 바꿀 때마다 모델 없이 테스트 83개, TUI 스모크 검사, 패키지 검사를 실행합니다. 실제 모델로는 16턴 대화에서 정한 사실 6개를 새 세션에서 다시 묻는 시나리오로 확인했습니다. 기억을 켜면 시험한 두 모델(Haiku, Luna) 모두 6개를 답했고, 끄면 하나도 답하지 못했습니다. 실행 명령과 토큰 사용량, 한계는 [검증 결과](docs/verification.ko.md)에 있습니다.

## 라이선스

[Apache-2.0](LICENSE). 출처 표시는 [NOTICE](NOTICE)에 있습니다.
