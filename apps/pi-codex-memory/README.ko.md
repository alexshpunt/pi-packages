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
| 모델 | Pi에서 쓸 수 있는 모델. 기본값은 현재 Pi 모델이며, 기억을 만들 때만 필요합니다. |

## 설치

아직 npm에 게시하지 않았으므로 저장소 소스에서 빌드해 Pi에 등록합니다.

```sh
git clone https://github.com/buYoung/pi-packages.git
cd pi-packages
pnpm install
pnpm --filter "@buyong/pi-codex-memory..." build
pi install ./apps/pi-codex-memory
```

설치한 뒤 Pi를 시작하면 `/codex-memory`와 `/codex-memory-settings` 명령을 쓸 수 있습니다. `pi remove ./apps/pi-codex-memory`로 등록을 지워도 저장된 기억은 남습니다.

저장소 소스로 빌드한 `@buyong/pi-codex` 번들에도 이 확장이 들어 있습니다. npm에 게시된 번들에는 아직 없습니다. 번들과 이 패키지를 함께 켜면 안 됩니다.

## 빠른 시작

검증에 쓴 설정으로 기억을 만들고 새 세션에서 꺼내 봅니다. 기억 생성 모델과 요약 모델은 모두 `claude-haiku-5-5 [claude-bridge]`이고 시간 설정은 기본값입니다. `claude-bridge` 공급자는 [@buyong/pi-claude-bridge](https://github.com/buYoung/pi-packages/blob/main/apps/pi-claude-bridge/README.ko.md) 확장이 제공하므로 그 안내에 따라 먼저 설치해 두어야 합니다. 모델 목록은 **Use current Pi model**로 시작하고, 이어서 Pi의 `/scoped-models`에서 고른 모델이 나옵니다. 고른 모델이 없으면 쓸 수 있는 모든 모델이 나오므로 원하는 모델이 들어 있는지 확인하세요.

기억을 켜면 대화 사본을 마스킹해 기억 생성 모델과 요약 모델에 보내므로 그만큼 요금이나 사용 한도를 씁니다. 마스킹이 모든 개인정보를 찾아내지는 못합니다.

Pi의 화면이 영어이므로 아래에서 굵게 표시한 항목 이름은 화면에 보이는 그대로 적었습니다.

### 1. 기억 켜기

1. 기억을 쓸 프로젝트 폴더에서 Pi를 시작하고 `/codex-memory`를 실행합니다. Pi의 `/settings`와 같은 모양으로 **Enabled**, **Memory model**, **Summary model**, **Memory scope**가 나오고, 커서가 있는 줄의 설명이 아래에 나옵니다. 두 모델은 처음에 **Current Pi model**이며, 대화에 쓰는 모델을 따릅니다.
2. **Memory model**에서 Enter를 누르고 `haiku`를 입력해 `claude-haiku-5-5 [claude-bridge]`를 고릅니다. **Summary model**도 같은 방법으로 고릅니다. 기억 생성 모델은 추론 강도 `low`로 추출하고, 요약 모델은 `medium`으로 통합합니다. 모델이 그 강도를 제공하지 않으면 가장 가까운 강도를 씁니다.
3. **Enabled**에서 Enter를 눌러 `on`으로 바꿉니다.
4. 모델을 보여 주는 **Send conversations to create memories?** 확인 창에서 허용합니다.

"Memory is on. A closed conversation becomes memory 2 hours after its last message." 알림이 뜨면 켜진 것입니다.

### 2. 결정을 기억으로 만들기

1. 대화에서 결정을 남깁니다. 예: `배포 게이트는 amber로 바꾸기로 했어. 이 프로젝트에만 적용해.`
2. `/codex-memory-settings`를 실행하고 **Remember this conversation now**를 고른 뒤 허용합니다. 이 줄은 기억이 켜져 있을 때만 보이며, 대화를 닫을 때까지 기다리지 않고 지금 기억을 만듭니다.
3. 끝나면 "Created memories from 1 conversation(s)." 알림이 뜹니다.
4. `/codex-memory`에서 **Saved memories**를 열면 저장된 기억이 보입니다.

### 3. 새 세션에서 꺼내 쓰기

1. 같은 프로젝트에서 `/new`로 새 세션을 엽니다.
2. `배포 게이트 뭐로 정했지?`라고 묻습니다.

에이전트는 요청마다 함께 전달되는 기억 요약을 보고, 더 필요하면 기억을 검색하고 읽습니다. 기억을 썼다면 `amber`라고 답하고 답 끝에 출처를 인용하며, 상태 표시줄에 인용이 표시됩니다.

```text
Memory: on · 1 cited
```

`1 cited`는 마지막 답이 에이전트가 실제로 읽은 기억을 인용했을 때만 나타나고, 읽은 내용과 맞지 않는 인용은 경고 알림으로 알려 줍니다. 같은 범위의 어느 Pi 세션에서든 기억 작업이 돌면 모든 세션에 `Memory: on · creating 3 memories…`나 `Memory: on · updating summary…`처럼 표시되며, 다른 세션에는 30초 안에 반영됩니다. `update failed`는 실패한 기억 작업이 아직 성공하지 못했다는 뜻입니다.

기억은 과거 대화의 기록입니다. 지금 코드도 그 상태라는 보장은 없으니 중요한 내용은 코드에서 다시 확인하세요.

## 평소에 쓰는 방식

기억이 켜져 있으면 닫은 대화가 백그라운드에서 기억이 됩니다. 이 작업은 기억 범위마다 열려 있는 Pi 세션 하나가 맡고, 그 세션이 닫히면 90초 안팎에 열려 있는 다른 세션이 이어받습니다. 열려 있는 Pi 세션이 하나도 없으면 처리하지 않습니다.

- 대화를 닫았고 마지막 메시지 뒤 2시간이 지나면 기억이 됩니다. 열어 둔 대화는 닫을 때까지 기다립니다.
- 한 번에 최대 8개 대화를 처리합니다.
- 기다리는 대화가 없을 때 새 기억을 요약에 합치며, 최대 2시간에 한 번입니다.
- 새로 입력하면 **Remember this conversation now** 작업만 멈춥니다. 백그라운드 작업은 닫은 대화를 읽으므로 계속 진행합니다.

자기 범위나 Personal에서 기억이 켜져 있으면 Pi 세션은 30초마다 열려 있다고 기록합니다. 이 기록이 90초 동안 갱신되지 않으면, 예를 들어 Pi를 종료했거나 Pi가 비정상 종료되면 그 대화를 닫힌 것으로 봅니다. 이 확장이 없는 Pi에서 열어 둔 대화도 닫힌 것으로 봅니다.

무언가를 바로 남기려면 에이전트에게 "기억해 줘"라고 요청합니다. 저장하기 전에 저장할 문장을 그대로 보여 주는 확인 창이 뜹니다. 대화 전체를 남기려면 `/codex-memory-settings`의 **Remember this conversation now**를 씁니다. 닫은 대화를 2시간 기다리지 않고 기억으로 만들려면 `/codex-memory`에서 **Create memories now**를 고른 뒤 범위를 선택합니다.

- **All closed conversations**: 이번 실행에서 기간 제한을 적용하지 않습니다.
- **Last 7 days**: **Use conversations from the last** 값을 적용합니다. 설정한 일수가 이름에 표시되며, 처음에는 이 항목이 선택되어 있습니다.

두 선택 모두 현재 기억 범위의 닫힌 대화만 처리하고 요약도 바로 갱신합니다. 변경 없는 대화와 잊은 기억은 다시 생성하지 않습니다. 이번 선택은 저장된 설정이나 자동 생성 동작을 바꾸지 않습니다. Esc를 누르면 작업을 시작하지 않고 기억 화면으로 돌아갑니다.

기억을 끄면 저장된 기억은 남지만 쓰지도 새로 만들지도 않습니다.

### 틀린 기억 고치기

`/codex-memory`에서 **Saved memories**를 엽니다. 글자를 입력해 목록을 좁히고 기억을 고른 뒤 **View memory and source**, **Edit memory**, **Forget memory** 중 하나를 고릅니다. 작업이 끝나면 같은 검색어로 목록이 다시 열려 다음 기억으로 넘어갈 수 있고, Esc를 누르면 `/codex-memory`로 돌아갑니다. 이 작업은 모델을 호출하지 않습니다.

- 고치거나 잊은 기억은 바로 요약과 검색 결과에서 빠집니다.
- 잊은 기억은 같은 대화에서 다시 만들어지지 않습니다. 원본 세션, 공급자 쪽 사본, 같은 사실이 담긴 다른 대화는 지우지 않습니다.

## 명령

두 명령 모두 인자를 받지 않고 Pi의 `/settings`와 같은 모양의 화면을 엽니다. Enter나 Space로 값을 바꾸고, 커서가 있는 줄의 설명이 아래에 나오며, Esc로 닫습니다.

| 명령 | 항목 |
| --- | --- |
| `/codex-memory` | **Enabled**, **Memory model**, **Summary model**, **Memory scope**, **Saved memories**, 기억이 켜져 있을 때 **Create memories now**(작업 중에는 **Stop current job**) |
| `/codex-memory-settings` | **Remember this conversation now**(작업 중에는 **Stop current job**), 실패 뒤에만 보이는 **Show what failed**, **Create memories after**, **Update the summary every**, **Use conversations from the last**, **Delete unused memories after**, **Other repositories**, **Forget all memories in this scope** |

화면을 열어도 진행 중인 작업은 멈추지 않습니다. UI가 없는 실행에서는 두 명령 모두 상태를 JSON으로 출력하며 아무것도 바꾸지 않습니다.

에이전트는 `pi_codex_memory_list`, `pi_codex_memory_search`, `pi_codex_memory_read`로 기억을 읽고, 기억해 달라고 요청한 내용은 `pi_codex_memory_note`로 저장합니다.

## 기억을 공유하는 범위

같은 Git 저장소의 하위 폴더와 worktree는 기억과 설정을 함께 씁니다. 따로 clone한 저장소, 중첩 저장소, 서브모듈은 각각 따로 씁니다. Git 밖에서는 폴더마다 따로 씁니다. 설정도 범위마다 따로이므로 다른 저장소에서는 기억을 다시 켜야 합니다.

범위는 저장소의 로컬 경로로 구분합니다. 저장소 폴더를 옮기면 기존 기억과 연결이 끊기고, 같은 경로에 다른 저장소를 두면 이전 기억을 이어받습니다.

여러 폴더에서 하나의 기억을 쓰려면 `/codex-memory`에서 **Memory scope**를 **Personal**로 바꿉니다. Personal로 정한 폴더는 모두 그 기억과 설정을 함께 씁니다. 범위를 바꿔도 기존 기억은 복사하거나 합치지 않습니다.

### 다른 저장소의 기억 읽기

`shop-web`에서 작업하면서 `shop-api`에서 정한 내용을 확인하는 예입니다.

1. `shop-web`에서 `/codex-memory-settings`를 실행하고 **Other repositories**를 엽니다.
2. `shop-api`를 고릅니다. 이 확장을 설치한 뒤 `shop-api`에서 Pi를 연 적이 없으면 목록에 없으므로 **+ Add repository**를 골라 폴더 경로를 입력합니다.
3. 에이전트가 묻지 않고 읽게 하려면 **Always allow reads**를, 읽을 때마다 확인하려면 **Ask each time**을 고르고 허용합니다.
4. 에이전트에게 "shop-api 기억에서 인증 방식 찾아 줘"처럼 저장소를 지정해 요청합니다. **Ask each time**을 골랐다면 이때 확인 창이 뜹니다.

접근은 한 방향입니다. `shop-web`이 `shop-api`를 읽게 해도 `shop-api`가 `shop-web`을 읽을 수는 없습니다. 다른 저장소의 기억은 읽기만 하고 요약에 넣거나 복사·수정하지 않습니다.

## 저장 위치와 기본값

기억은 프로젝트가 아니라 `~/.pi/agent/pi-codex-memory/`에 저장합니다. `PI_CODING_AGENT_DIR`을 설정하면 그 아래에 저장합니다. 원본은 `state.sqlite`이고 `scopes/` 아래 Markdown 파일은 여기서 만든 사본입니다. Markdown을 직접 고치지 말고 `/codex-memory`의 **Saved memories**로 관리하세요.

설정은 범위마다 따로 저장합니다. `/codex-memory-settings`에서 Enter나 Space를 누르면 값이 바뀌며 바로 저장되고, 진행 중인 기억 작업을 멈춘 뒤 다음 작업부터 적용됩니다.

| 설정 | 기본값 | 고를 수 있는 값 | 바꾸는 것 |
| --- | --- | --- | --- |
| Create memories after | 2 hours idle | 15분, 30분, 60분, 2시간, 6시간 | 닫은 대화가 마지막 메시지 뒤 얼마나 지나서 기억이 되는지 정합니다. 짧을수록 기억이 빨리 생기지만, 다시 열어 이어 간 대화는 다시 추출합니다. |
| Update the summary every | 2 hours | 15분, 30분, 60분, 2시간, 3시간, 6시간 | 새 기억은 바로 검색할 수 있고, 요청마다 전달되는 요약에는 이 간격으로 합쳐집니다. |
| Use conversations from the last | 7 days | 1일, 3일, 7일, 14일, 30일 | 마지막 메시지가 이보다 오래된 대화는 건너뜁니다. 수동 실행에서 **All closed conversations**를 고르면 이번 실행에만 이 제한을 적용하지 않습니다. |
| Delete unused memories after | 30 days | 7일, 30일, 90일, 365일 | 에이전트에게 저장을 요청한 기억과 직접 고친 기억은 남깁니다. |

다음 값은 고정입니다. 한 번에 처리하는 대화는 최대 8개, 모델 호출당 입력은 256 KiB, 요청마다 전달하는 요약은 12 KiB까지입니다.

기본값을 정한 근거와 조정 기준은 [검증 결과](docs/verification.ko.md#기본값을-정한-방법)에 있습니다.

## 검증

코드를 바꿀 때마다 모델 없이 테스트 124개, TUI 스모크 검사, 패키지 검사를 실행합니다. 실제 모델로는 16턴 대화에서 정한 사실 6개를 새 세션에서 다시 묻는 시나리오로 확인했습니다. 기억을 켜면 시험한 두 모델(Haiku, Luna) 모두 6개를 답했고, 끄면 하나도 답하지 못했습니다. 실제 Pi 프로세스 여러 개로 한 검사에서는 닫은 대화만 한 번씩 기억이 되었고, 작업을 맡은 프로세스를 강제로 종료하자 다른 세션이 이어받았습니다. 실행 명령과 토큰 사용량, 한계는 [검증 결과](docs/verification.ko.md)에 있습니다.

의존성을 설치한 뒤 저장소 루트에서 실행합니다.

```sh
pnpm --filter "@buyong/pi-codex-memory..." build
pnpm --filter @buyong/pi-codex-memory typecheck
pnpm --filter @buyong/pi-codex-memory test
python3 apps/pi-codex-memory/verification/tui-smoke.py
```

모델 계정 없이 실행할 수 있습니다. TUI 검사는 `pi`가 `PATH`에 있어야 하며, 범위 선택·취소와 대상 대화가 없는 실행을 확인합니다.

## 라이선스

[Apache-2.0](LICENSE). 출처 표시는 [NOTICE](NOTICE)에 있습니다.
