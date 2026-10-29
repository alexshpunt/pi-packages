# pi-refuseless

[English](README.md) | **한국어**

[Pi](https://github.com/earendil-works/pi)에 [Refuseless](https://docs.refuseless.com/introduction)를 모델 공급자로 추가합니다. Pi의 `/login`에서 Refuseless API 키를 입력하면 `/model`에 그 키로 쓸 수 있는 Refuseless 모델이 나옵니다. Refuseless 모델을 쓰는 동안에는 상태 줄에 쓸 수 있는 크레딧이 나옵니다.

## 요구 사항

- Node.js 22.19.0 이상과 Pi(Pi 1.4.0에서 테스트)
- Refuseless 콘솔에서 만든 API 키. 키는 `abl_`로 시작합니다. 요청할 때마다 Refuseless 크레딧이 쓰입니다.

## 설치

npm에서 설치하세요.

```bash
pi install npm:@buyong/pi-refuseless
```

또는 이 저장소를 내려받은 위치에서 설치하세요.

```bash
pi install /path/to/pi-packages/apps/pi-refuseless
```

그다음 Pi를 다시 시작하거나, 실행 중인 Pi에서 `/reload`를 실행하세요. 저장소에서 설치했다면 그 폴더를 옮기거나 지우지 마세요. Pi는 로컬 패키지를 복사하지 않고 그 위치에서 읽습니다.

설치하지 않고 한 세션만 써 보려면 `pi -e /path/to/pi-packages/apps/pi-refuseless`로 Pi를 시작하세요.

## 로그인하고 모델 고르기

Pi에서 다음 순서로 진행하세요.

1. `/login`을 실행하고 **Sign in with an API key**, **Refuseless**를 차례로 고르세요.
2. API 키를 붙여 넣고 Enter를 누르세요. Pi가 `Saved API key for Refuseless. Credentials saved to <경로>`를 표시하고, 키를 Pi의 `auth.json`(기본값 `~/.pi/agent/auth.json`)에 저장한 뒤 그 키로 모델 목록을 받아 옵니다.
   이전에 고른 모델이 없으면 `Saved API key for Refuseless, but no default model is configured for provider "refuseless". Use /model to select a model.`도 표시됩니다. 다음 단계로 진행하면 됩니다.
3. `/model`을 실행하고 Refuseless 모델을 고르세요. Enter를 누르면 지금 세션에만 적용되고, Ctrl+S를 누르면 새 세션의 기본 모델로도 저장됩니다.

저장한 키는 Pi를 다시 시작해도 유지됩니다. 저장한 키가 없으면 Pi는 `REFUSELESS_API_KEY` 환경 변수를 사용합니다. 키 입력 화면에서 Escape를 누르거나 키 없이 Enter를 누르면 아무것도 저장하지 않으며, 전에 저장한 키도 그대로 남습니다.

Refuseless가 키를 거부해도 Pi는 키를 저장합니다. 이때 `Saved API key for Refuseless, but its model catalog could not be refreshed; using cached models.`를 표시하고, 전에 있던 모델 목록을 그대로 둡니다(첫 로그인이면 목록이 비어 있음). 올바른 키로 `/login`을 다시 실행하세요.

### 지금 세션이 어떤 모델을 쓰는지 확인하기

`/model`에서 Enter를 누르면 지금 세션에만 적용됩니다. 새 세션(Pi를 다시 시작, `/new`, 다른 터미널)은 Pi의 기본 모델로 시작하며, 그 모델이 다른 공급자의 모델이어도 Pi는 경고를 표시하지 않습니다. 모델을 믿고 쓰기 전에 확인하세요.

- `/model` 목록에서 현재 모델에는 `✓`가 붙고, 줄마다 공급자가 나옵니다. 예: `✓ glm-5.3-abliterated [refuseless]`. 기본 모델에는 `· default`가 붙습니다.
- 화면 맨 아래 상태 줄에는 현재 모델과 생각 수준이 나옵니다. 예: `glm-5.3-abliterated • low`. 공급자를 두 개 이상 설정했으면 공급자도 함께 나옵니다. 예: `(refuseless) glm-5.3-abliterated • low`.

새 세션을 Refuseless 모델로 시작하려면 `/model`에서 Ctrl+S로 고르세요. Pi가 `Default model: refuseless/<모델 ID>`를 표시합니다. 기본 모델을 바꾸지 않고 한 번만 그 모델로 시작하려면 `pi --model refuseless/<모델 ID>`를 쓰세요.

## 모델

이 패키지에는 고정된 모델 목록이 없습니다. Pi는 `/login` 직후, `/model`을 열 때, 대화형 Pi를 시작할 때 키로 Refuseless에서 모델 목록을 받아 오고, abliterated 여부와 관계없이 받은 모델을 모두 표시합니다. Refuseless는 모델마다 abliterated(가중치에서 거부 동작을 없앤 모델)인지 표시하며, 이 표시는 [`cli models`](#직접-써-보기)로 볼 수 있습니다. 마지막으로 받은 목록은 저장해 두었다가, 목록을 받아 올 수 없을 때(예: `pi -p`, `pi --list-models`) 씁니다. 저장된 목록을 새로 받으려면 대화형 Pi에서 `/model`을 한 번 여세요.

Pi는 모델마다 다음 값을 씁니다.

- **컨텍스트**: Refuseless가 알려 주는 컨텍스트 크기. 알려 주지 않으면 128,000 토큰
- **생각 수준**: Refuseless가 그 모델에 대해 알려 주는 수준(아래 참고)
- **최대 출력**: 131,072 토큰. 컨텍스트 크기가 더 작으면 컨텍스트 크기
- **입력**: 텍스트만
- **비용**: 표시하지 않음. [refuseless.com/pricing](https://refuseless.com/pricing)과 Refuseless 콘솔에서 확인

### 생각 수준

Refuseless의 생각 수준은 `off`, `low`, `high`, `max` 네 가지입니다. 모델마다 이 중 일부를 지원하고, 기본 생각 수준이 하나씩 있습니다. Pi는 모델이 지원하는 수준만 보여 줍니다. 예를 들어 GLM 모델은 `low`, `high`, `max`를 지원하므로 Pi에 `off`가 나오지 않습니다. `off`만 지원하는 모델에는 Pi의 생각 수준이 없습니다. 모델별 지원 수준과 기본 생각 수준은 [`cli models`](#직접-써-보기)로 볼 수 있습니다.

모델이 어떤 수준으로 시작하는지는 다음과 같습니다.

- **아직 생각 수준이 정해지지 않은 세션에서 고른 경우**: 그 모델의 기본 생각 수준으로 시작합니다. 모델 없이 시작한 새 세션(Pi가 생각 수준을 `off`로 둠)과, 생각 수준이 없는 모델에서 바꾼 경우가 여기에 해당합니다.
- **생각 수준이 있는 모델을 쓰다가 고른 경우**: Pi가 쓰던 수준을 이어 갑니다. 새 모델이 그 수준을 지원하지 않으면 지원하는 다음 수준으로 바꿉니다. 예: `off`는 `low`, `xhigh`는 `max`.
- **Refuseless 모델로 새 세션을 시작한 경우**: Pi 설정을 따릅니다. `--thinking`, `/settings`의 기본 생각 수준, 둘 다 없으면 `medium` 순입니다. Refuseless에는 `medium`이 없으므로 Pi가 `high`로 바꿉니다.

`/settings`의 모델별 생각 수준이나 기본 생각 수준, `--models`로 정한 수준이 있으면 앞의 두 경우에는 그 설정이 적용됩니다. 예외가 하나 있습니다. 아직 생각 수준이 정해지지 않은 세션에서 설정이 `off`(`off`가 없는 모델에서는 가장 낮은 수준)이면 그 모델의 기본 생각 수준으로 시작합니다.

지금 모델의 생각 수준은 Shift+Tab으로 바꾸세요.

Pi는 생각 수준을 다음 값으로 Refuseless에 보냅니다.

| Pi 수준 | Refuseless에 보내는 수준 |
| --- | --- |
| off | `off` |
| minimal, low | `low` |
| medium, high | `high` |
| xhigh, max | `max` |

## 크레딧 확인하기

대화형 Pi에서 Refuseless 모델을 쓰는 동안 화면 맨 아래 상태 줄에 새 요청이 쓸 수 있는 크레딧이 나옵니다. 예: `Refuseless $41.30`. Pi는 Refuseless 모델로 세션을 시작할 때, `/model`에서 Refuseless 모델을 고를 때, 응답이 끝날 때마다 잔액을 읽어 옵니다. 잔액을 읽을 때는 크레딧이 들지 않습니다.

잔액 전체를 보려면 `/pi-refuseless`를 실행하세요.

| 줄 | 뜻 |
| --- | --- |
| Available | 새 요청이 쓸 수 있는 금액. 잔액에서 진행 중인 요청이 잡아 둔 금액을 뺀 값이며, Key limit을 넘지 않습니다. 상태 줄에는 이 금액이 나옵니다. |
| Balance | 진행 중인 요청이 잡아 둔 금액을 포함한 유료 크레딧. 무료 프로모션 크레딧과 요금제 사용량은 들어가지 않으므로, Available이 `$0.00`이어도 프로모션·요금제 모델 요청은 성공할 수 있습니다. |
| Reserved | 진행 중인 요청이 지금 잡아 둔 금액. 요청이 끝나면 쓰지 않은 금액은 잔액으로 돌아옵니다. |
| Key limit | 이 키의 지출 한도(또는 워크스페이스 한도)에서 남은 금액. 키에 한도가 없으면 `none`. |

상태 줄 표시를 끄려면 `/pi-refuseless`에서 **Credits in status line**을 고르고 Enter나 Space를 누르세요. 다시 켤 때도 같은 방법을 씁니다. 닫으려면 Escape를 누르세요. 바꾼 설정은 바로 적용되고 Pi 에이전트 폴더의 `refuseless.json`(기본값 `~/.pi/agent/refuseless.json`)에 저장되므로 다음 세션에도 유지됩니다.

키가 없거나 Refuseless가 응답하지 않으면 상태 줄에 크레딧이 나오지 않습니다. 이때 `/pi-refuseless`를 실행하면 이유가 나옵니다. 예: `No Refuseless API key. Run /login and choose Refuseless.` 대화형 Pi가 아닐 때 `/pi-refuseless`는 잔액을 알림으로 보여 주고, `pi -p`에서는 stderr로 출력합니다.

## 오류

Refuseless가 요청을 거부하면 Pi는 응답을 멈추고 Refuseless의 오류를 표시합니다. 예를 들면 다음과 같습니다.

- `401 invalid_key`: 키가 잘못되었습니다. `/login`을 다시 실행하세요.
- `402 insufficient_credits`: 크레딧을 충전하세요. 응답 도중에 이 오류로 끝날 수도 있습니다. Refuseless는 요청을 시작하기 전에 그 요청에 들 수 있는 최대 금액을 잡아 두므로, Available이 그보다 적으면 응답이 일찍 끝날 수 있습니다. 쓸 수 있는 금액은 `/pi-refuseless`로 확인하세요.
- `429 model_busy` 또는 `model_warming`: 잠시 뒤에 다시 시도하세요.

## models.json에도 refuseless가 있을 때

Refuseless [SDKs](https://docs.refuseless.com/sdks.md) 안내의 Pi 설정은 `~/.pi/agent/models.json`에 `refuseless` 공급자를 추가합니다. 그 모델 항목은 이 패키지의 모델 중 ID가 같은 모델을 생각 수준까지 포함해 덮어씁니다. 이 패키지를 쓸 때는 models.json의 `refuseless` 항목을 지우세요.

## 로그아웃, 업데이트, 제거

- 저장한 Refuseless 키를 지우려면 `/logout`을 실행하고 **Refuseless**를 고르세요. Pi가 `Removed stored API key for Refuseless. Environment variables and models.json config are unchanged.`를 표시합니다. `REFUSELESS_API_KEY`와 다른 공급자의 키는 남습니다.
- 패키지나 저장소를 업데이트한 뒤에는 `/reload`를 실행하거나 Pi를 다시 시작하세요.
- 패키지를 제거하려면 npm 설치는 `pi remove npm:@buyong/pi-refuseless`, 로컬 설치는 `pi remove /path/to/pi-packages/apps/pi-refuseless`를 실행하세요. 저장소 폴더, 저장한 키, `refuseless.json`은 남으므로, 키도 지우려면 먼저 `/logout`을 실행하세요.

## 개발과 검증

`pnpm install`을 실행한 뒤 저장소 루트에서 다음을 실행하세요.

```bash
pnpm --filter @buyong/pi-refuseless typecheck
pnpm --filter @buyong/pi-refuseless test:unit
pnpm --filter @buyong/pi-refuseless cli verify
```

- `typecheck`와 `test:unit`은 종료 코드 0으로 끝납니다. 테스트는 Refuseless API를 흉내 내는 로컬 모의 서버로만 요청을 보내므로 키가 필요 없고 크레딧도 쓰지 않습니다.
- `cli verify`에는 Pi 설치(`pi`가 PATH에 있어야 함)도 필요합니다. 테스트를 실행하고, 패키지를 검사하고, 설치된 `pi`가 모의 서버에서 모델 목록을 받아 `pi -p` 요청 1회에 답하는지 확인합니다. `All … checks passed.`와 종료 코드 0으로 끝나며, 보고서를 둔 폴더를 출력합니다.

이 명령들은 `~/.pi/agent`를 바꾸지 않고, 각자의 에이전트 폴더를 씁니다.

### 직접 써 보기

Refuseless 키 없이 로컬 모의 서버로 Pi와 이 패키지를 써 보려면 다음을 실행하세요.

```bash
pnpm --filter @buyong/pi-refuseless cli pi --mock
```

Pi에서 `/login`을 실행하고 **Sign in with an API key**, **Refuseless**를 고른 뒤 `abl_`로 시작하는 아무 키나 입력하세요. 그다음 `/model`에서 Refuseless 모델을 고르고 메시지를 보내세요. 모의 서버는 실제 Refuseless 모델 목록을 저장해 둔 사본에서 모델 6개를 생각 수준·기본 생각 수준과 함께 보여 주고, `Mock Refuseless reply from <모델>`로 답합니다. 잔액으로는 Refuseless 문서의 예시 값을 돌려주므로 상태 줄에 `Refuseless $41.30`이 나옵니다. 메시지에 `tool`, `credits`, `busy`가 들어 있으면 각각 `bash` 도구 호출, `insufficient_credits` 오류로 끝나는 응답, `429` 응답을 돌려줍니다.

Pi를 끝내면 명령이 `Run again in this directory:`와 함께 다시 시작하는 명령을 출력합니다. 그 명령을 실행하면 키와 모델 목록이 재시작 뒤에도 남아 있는지 확인할 수 있습니다.

키로 실제 서비스를 써 보려면 다음을 실행하세요(채팅 요청은 크레딧을 씁니다).

```bash
pnpm --filter @buyong/pi-refuseless cli pi
```

Pi에서 키로 로그인한 뒤 모델을 골라 써 보거나, 모델 목록만 확인하려면 바로 Pi를 끝내세요. 그 키로 Refuseless가 돌려주는 모델을 보려면, Pi를 끝낼 때 출력된 명령에서 `--dir` 뒤의 폴더를 넣어 `cli models`를 실행하세요.

```bash
pnpm --filter @buyong/pi-refuseless cli models --dir <폴더>
```

`cli models`는 Pi에 등록되는 모델을 생각 수준·기본 생각 수준·abliterated 여부와 함께 보여 준 뒤, Refuseless가 돌려준 모델 항목을 그대로 출력합니다. 채팅 요청은 보내지 않습니다. `--dir` 없이 실행하면 `REFUSELESS_API_KEY`를 쓰고, `--mock`을 주면 모의 서버의 목록을 보여 줍니다.

실제 모델과의 대화 전체를 확인하려면 다음을 실행하세요(채팅 요청은 크레딧을 씁니다).

```bash
REFUSELESS_API_KEY=<키> pnpm --filter @buyong/pi-refuseless cli live --model glm-5.3-abliterated --model deepseek-v4.1-flash-abliterated
```

`cli live`는 지정한 모델마다 설치된 `pi`(이 패키지 포함)를 하나씩 동시에 실행해 10턴 동안 대화합니다. 10턴에 걸쳐 짧은 답, 앞에서 준 암호 기억, `bash` 도구 호출 2번, 생각 수준 `high`·`low`·`off` 전환을 확인하며, 턴과 모델마다 `pass` 또는 `FAIL`을 출력하고 마지막에 JSON 보고서 경로를 알려 줍니다.

`--turns N`을 주면 N턴에서 멈춥니다. `--dir <폴더>`를 주면 `REFUSELESS_API_KEY` 대신 `cli pi`가 저장한 키를 씁니다. `cli live`는 키를 디스크에 저장하지 않습니다.

`cli mock`은 모의 서버만 실행하고 받은 요청을 하나씩 출력합니다. `cli --help`로 모든 명령과 옵션을 볼 수 있습니다.

## 테스트 환경

- Pi 1.4.0(설치된 CLI와 자동 테스트), Node.js 24.14.0, macOS
- 자동 테스트는 로컬 모의 서버로 실행하며, 모의 서버는 2026-10-27에 Refuseless가 돌려준 모델 목록을 씁니다.
- 2026-10-27에 실제 서비스에서 `cli live`로 `glm-5.3-abliterated`, `glm-5.3-flash-abliterated`, `deepseek-v4.1-flash-abliterated`가 10턴을 모두 통과했습니다. 목록의 다른 모델은 실제 서비스에서 써 보지 않았습니다.
- `deepseek-v4.1-flash-abliterated`는 `high`를 포함한 어떤 생각 수준에서도 생각 내용을 돌려주지 않았습니다. Refuseless API에 직접 요청해도 같았으므로, Pi에도 이 모델의 생각 내용은 나오지 않습니다.
- 크레딧 표시, `/pi-refuseless`, abliterated 표시는 로컬 모의 서버로만 확인했습니다. 모의 서버의 abliterated 값은 모델 ID를 보고 정한 것이며, 실제 서비스에서 받은 값이 아닙니다.

검사 항목과 결과는 [verification/acceptance.ko.md](verification/acceptance.ko.md)에 있습니다.

## 라이선스

MIT
