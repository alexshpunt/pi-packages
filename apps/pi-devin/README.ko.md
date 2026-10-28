# pi-devin

[English](README.md) | **한국어**

Devin 계정으로 [Pi](https://github.com/earendil-works/pi)에서 Devin 모델을 쓰게 해 주는 **비공식** 공급자입니다.

> 이 패키지는 Cognition(Devin을 만든 회사)이 만들거나 보증하지 않습니다. 예고 없이 바뀔 수 있는 비공개 Devin CLI API를 사용합니다. 서비스 약관 위반이나 계정 제한의 위험을 판단하고 감수하는 책임은 사용자에게 있습니다.

## 기능

- Pi의 `/login`(OAuth)으로 Devin 계정에 로그인합니다. API 키는 쓰지 않습니다.
- 계정이 쓸 수 있는 Devin 모델을 `/model`에서, 추론 수준을 `/thinking`에서 고릅니다.
- **Devin Fusion**: 주 모델(lead)이 보조 모델(sidekick)에게 작업을 맡깁니다.
- **`/devin`**: 사용량 한도와 세션 사용량을 보고 표시 설정을 바꿉니다.

## 요구 사항

- Node.js 22.19.0 이상과 Pi(1.4.0에서 테스트)
- Devin CLI를 쓸 수 있고 사용량 한도가 남아 있는 Devin 계정. 둘 중 하나라도 없으면 로그인에 성공해도 대화할 수 없습니다.

## 설치

```bash
pi install npm:@buyong/pi-devin
```

Pi를 다시 시작하거나, 실행 중인 Pi에서 `/reload`를 실행합니다.

한 프로젝트에서만 쓰려면 그 프로젝트 안에서 `pi install npm:@buyong/pi-devin -l`을 실행합니다. 프로젝트 패키지는 신뢰한 프로젝트에서만 로드됩니다.

## 설치 확인

사용자 전체에 설치했다면 아무 디렉터리의 셸에서 다음 명령을 실행합니다. `-l`로 한 프로젝트에만 설치했다면 신뢰한 그 프로젝트 디렉터리에서 실행하며, 이때 `pi list`는 패키지를 `Project packages:` 아래에 표시합니다. Devin 계정이 필요 없고 Devin에 요청을 보내지 않습니다.

```bash
node --version   # 22.19.0 or later
pi --version     # tested with 1.4.0
pi list          # "User packages:" includes npm:@buyong/pi-devin and its installed path
```

`node --version`은 22.19.0 이상이어야 하고, `pi list`의 `User packages:`에 `npm:@buyong/pi-devin`과 설치 경로가 나와야 합니다. Pi는 1.4.0에서 테스트했습니다.

그다음 `pi`를 시작하고 Pi 안에서 다음을 입력합니다.

| Pi 입력 | 기대 결과 |
| --- | --- |
| (시작) | pi-devin이 언급된 `[Extension issues]` 항목이 없음 |
| `/devin` | 사용량·설정 화면이 열립니다. 로그인 전에는 `Account quota · not received yet`이 표시됩니다. 네트워크 요청은 보내지 않습니다. esc로 닫습니다. |
| `/devin-fusion` | 로그인 전: `No Devin models are available for Fusion.` 경고. 로그인 후: 주 모델과 보조 모델을 고르는 두 열 선택 화면 |
| `/reload` 뒤 다시 `/devin` | 확장 오류 없이 같은 화면 |

## 시작하기

1. Pi에서 `/login` → **Sign in with an account** → **Devin**을 실행합니다.
2. 브라우저 로그인이나 직접 입력을 고릅니다. 직접 입력에서는 브라우저 로그인 페이지에 표시된 일회용 코드를 붙여 넣습니다. API 키와 세션 토큰은 받지 않습니다.
3. 모델 목록이 갱신되면 `/model`에 `[devin]`으로 끝나는 항목이 나타납니다. 하나를 고릅니다.
4. 필요하면 `/thinking`에서 추론 수준을 고릅니다. 쓸 수 있는 수준은 모델마다 다릅니다. 예를 들어 SWE-2는 medium, high, max를 제공합니다.
5. `Please say hello briefly.` 같은 짧은 메시지를 보냅니다. 답이 오면 로그인과 모델이 동작한다는 뜻입니다. 이 메시지부터 요청이 계정 사용량을 씁니다. 모델이 호출한 도구는 Pi가 실행합니다.

[Devin Fusion](#devin-fusion)을 써 보려면 `/model`에서 **Devin Fusion**(`fusion`)을 고르고 작은 작업을 요청합니다. 주 모델이 `devin_sidekick` 도구를 호출하고, 보조 모델의 보고를 답에 반영합니다.

## 모델 목록

- 목록은 모델 계열마다 ID로 항목 하나를 보여 줍니다(예: `claude-opus-4.8 [devin]`). 이름(`Claude Opus 4.8`)은 선택한 행 아래의 `Model Name`에 나옵니다.
- 추론 수준별 변형은 따로 나열하지 않으며 `/thinking`으로 고릅니다. "Recommended models only"를 켜면 목록이 바뀝니다([`/devin`: 사용량과 표시 설정](#devin-사용량과-표시-설정) 참고).
- Fast Mode처럼 옵션이 다른 변형이 있는 계열은, ID에 옵션을 붙인 별도 항목으로 나옵니다(예: `claude-opus-4.8-fast-mode`).
- 보이는 모델과 기능은 계정에 따라 다릅니다.
- 가격이 `0`이면 무료가 아니라 비용을 모른다는 뜻입니다.

## `/devin`: 사용량과 표시 설정

TUI에서 `/devin`을 실행하면 다음을 한 화면에 보여 줍니다. ↑↓로 이동하고, space나 Enter로 켜고 끄며, esc로 닫습니다.

- 계정 사용량 한도: 일간·주간 남은 비율 막대, 재설정 시각, 데이터를 가져온 시각
- 이 세션의 사용량: 요청 수와 입력·출력·캐시 토큰. 보조 모델 대화는 포함하지 않습니다.

설정 두 개가 있으며 둘 다 기본값은 꺼짐입니다. 바꾸면 모든 세션에 한 번에 적용됩니다.

- **Recommended models only**: `/model`에 Devin이 Recommended로 표시한 변형이 있는 모델과 Devin Fusion만 보여 줍니다. Devin은 `swe-2-high` 같은 개별 변형을 표시하지만, 목록에는 모델 자체(`swe-2`)가 남으므로 추론 수준은 계속 `/thinking`으로 고릅니다. 권장 수준이 자동으로 적용되지는 않습니다. 계정에 권장 모델이 없으면 전체 목록을 보여 줍니다.
- **Usage in status line**: TUI 하단에 남은 일간·주간 사용량 막대와 이 세션의 입력·출력 토큰을 `devin day ▕█████████░▏98% week ▕█████████░▏98% · ↑263 ↓49`처럼 표시합니다. 막대는 40% 이하에서 경고 색, 20% 이하에서 오류 색으로 바뀝니다. Devin Fusion을 포함해 Devin 모델을 선택했을 때만 보이고, 다른 공급자의 모델로 바꾸면 사라집니다. `/devin`은 어떤 모델을 선택했든 사용량을 보여 줍니다.

사용량 한도는 실시간이 아닙니다. 로그인할 때와 각 모델 요청 직전의 계정 확인에서 갱신되며, 같은 Pi agent 디렉터리를 쓰는 서브에이전트와 Fusion 보조 모델의 요청도 여기에 포함됩니다. 따라서 방금 보낸 메시지의 사용량은 다음 요청 뒤에 반영됩니다.

`/devin`과 상태 표시줄은 네트워크 요청을 보내지 않으며, 상태 표시줄은 다른 Pi 프로세스가 기록한 값을 턴이 끝날 때마다 반영합니다. 크레딧, 요청별 비용, 사용 기록은 표시하지 않습니다.

필터를 바꿔 지금 쓰는 모델이 목록에서 빠져도, 현재 세션에서는 계속 쓸 수 있습니다. 세션을 다시 열면 그 모델은 복원되지 않으므로 목록에서 모델을 다시 고르세요.

RPC 모드처럼 TUI가 아닌 환경에서는 `/devin recommended on|off`와 `/devin status on|off`로 설정을 바꿉니다. 인자 없이 `/devin`을 실행하면 사용량 한도·사용량·설정을 알림으로 보냅니다.

## Devin Fusion

`/model`에서 **Devin Fusion**(`fusion`)을 고르면 주 모델에 `devin_sidekick` 도구가 켜집니다. 주 모델은 이 도구로 보조 모델에게 작업을 맡기고 보고를 받습니다. 다른 모델로 바꾸면 도구가 꺼집니다.

- 기본 조합은 SWE-2(주 모델)와 SWE-2 Medium(보조 모델)입니다. 계정에 SWE-2 Medium이 없으면 Fusion 항목이 나오지 않습니다.
- 조합은 `/devin-fusion`으로 바꿉니다. TUI에서는 두 열에서 주 모델과 보조 모델을 함께 고릅니다. tab으로 열을 바꾸고, 글자를 입력해 거르고, Enter로 저장합니다. ★는 권장 모델, ●는 저장된 조합입니다.
- 인자로도 지정할 수 있습니다: `/devin-fusion <주 모델 ID> <보조 모델 ID>`(예: `/devin-fusion swe-2 swe-2-high`). 주 모델은 `/model` 목록의 계열 ID이고, 보조 모델은 추론 수준이 고정된 변형 ID입니다. TUI 선택 화면을 쓰면 ID를 몰라도 됩니다. 저장한 조합은 모든 세션에 적용됩니다.
- 주 모델의 추론 수준은 `/thinking`을 따릅니다.
- 보조 모델은 주 모델 세션마다 별도의 Pi 프로세스로 실행됩니다. 작업 디렉터리, 활성 도구, Devin 로그인을 주 모델과 공유합니다.
- 기본적으로 주 모델은 보조 모델의 보고를 기다립니다. 주 모델이 `devin_sidekick`을 `block: false`로 호출하면 보조 모델이 일하는 동안 계속 작업하고, 보고가 메시지로 도착하면 다시 실행되어 처리합니다. 주 모델이 나중에 실행 중인 그 작업을 기다리면 보고를 도구 결과로 받습니다. 주 모델이 기다리는 동안 사용자가 메시지를 보내면 기다림이 끝나고 작업은 백그라운드로 넘어갑니다.
- 주 모델을 취소하면 주 모델이 기다리던 보조 작업도 멈춥니다. 작업을 넘기기 전에 이미 취소된 호출은 `block: false`여도 아무 작업도 시작하지 않습니다. 보조 모델과의 연결이 끊기면 그 작업은 실패하고 보조 모델 프로세스를 닫으며, 주 모델의 Pi는 종료하지 않습니다.
- 긴 보조 모델 보고는 주 모델이 받기 전에 잘리며, 전체 내용은 임시 파일에 저장합니다([제한과 동작](#제한과-동작) 참고).
- `pi --tools`로 도구를 제한했다면 Fusion이 동작하도록 목록에 `devin_sidekick`을 넣으세요.
- Fusion에서 주 모델과 보조 모델은 각자 호출한 모델의 일반 요청으로 사용량을 씁니다.

## 제한과 동작

| 항목 | 동작 |
| --- | --- |
| 요청 제한 시간 | Pi가 설정한 값을 따릅니다(기본 300초). 응답이 계속 들어오는 동안에는 끊지 않고, 그 시간 동안 데이터가 오지 않을 때만 실패합니다. |
| 프롬프트 캐시 | 기본은 짧은 캐시입니다. `PI_CACHE_RETENTION=long`은 Devin이 24시간 캐시로 표시한 모델에만 허용하며, 다른 모델에서는 요청을 보내기 전에 거부합니다. |
| 이미지 | 지원하는 모델에서 이미지당 최대 4 MiB, 메시지당 합계 최대 5 MiB입니다. 이미지를 지원하지 않는 모델로 바꾸면 이전 이미지는 생략했다는 안내 문구로 바뀝니다. |
| 보조 모델 보고 | 주 모델은 보고마다 상태·오류·안내를 포함해 최대 약 131,072토큰(524,288자, Pi의 문맥 추정처럼 4자를 1토큰으로 계산)을 받습니다. 더 긴 보고는 잘리고, 끝에 전체 보고가 담긴 임시 파일 경로가 붙습니다([저장 위치](#저장-위치) 참고). 저장에 실패하면 잘린 보고에 안내를 대신 붙입니다. |
| print·JSON 모드 | 이 모드는 모델 목록을 가져오지 않고, 이전 TUI나 RPC 세션이 저장한 목록을 씁니다. 로그인한 상태로 TUI나 RPC 모드를 한 번 이상 실행해 목록을 저장해야 하며, 그러지 않으면 `--model devin/<모델 ID>`를 찾지 못합니다. |

- 모델 요청 직전의 계정 확인이 Devin 서버에 닿지 못하면(예: `ECONNREFUSED`나 503) 저장된 로그인을 그대로 써서 요청을 보냅니다. 연결이 거부되거나 재설정되거나 응답 도중 끊긴 모델 요청은 `Connection error (…)`로 보고되며, Pi의 자동 재시도가 이를 인식합니다. 장애가 계속되면 `OAuth refresh failed` 대신 이 연결 오류를 보고합니다.
- 401 오류가 나면 다시 로그인하세요. 403, 429, 시간 초과는 로그인 만료로 보지 않습니다. 다시 로그인해도 해결되지 않으면 계정 권한, 사용량 한도, 네트워크를 확인하세요.
- 응답을 받는 도중 오류가 나면 그 응답의 도구 호출은 실행하지 않습니다. 메시지를 다시 보내세요.

## 기기 정보

Devin CLI처럼 Devin 서버로 보내는 요청에는 기기 정보가 들어갑니다. macOS에서는 기기 일련번호와 네트워크 MAC 주소를, 다른 OS에서는 MAC 주소와 사용자 이름을 읽습니다. 이를 끄는 설정은 없습니다.

## 저장 위치

| 내용 | 위치 |
| --- | --- |
| Pi 로그인 데이터 | Pi가 관리합니다. 기본 `~/.pi/agent/auth.json` |
| 패키지 설정 | Pi agent 디렉터리의 `pi-devin/settings.json`(`/devin`)과 `pi-devin/fusion.json`(`/devin-fusion`) |
| 마지막 계정 사용량 한도 | Pi agent 디렉터리의 `pi-devin/account-usage.json`. 사용량 한도 값과 로그인 세션의 해시만 담으며, 토큰이나 계정 ID는 없습니다. |
| 보조 모델 대화 | Pi agent 디렉터리의 `pi-devin/sidekick/<주 모델 세션 ID>.jsonl` |
| 잘린 보조 모델 보고의 전체 내용 | 시스템 임시 디렉터리의 `pi-devin-sidekick-report-*/report.md`. 본인만 읽을 수 있습니다. 보고가 한도를 넘을 때만 기록하며, 시스템이 나중에 지울 수 있습니다. |

Pi agent 디렉터리의 기본값은 `~/.pi/agent`이며 `PI_CODING_AGENT_DIR`로 바꿀 수 있습니다.

## 업데이트, 로그아웃, 제거

```bash
pi update npm:@buyong/pi-devin   # updates only this package (plain `pi update` updates Pi itself)
pi remove npm:@buyong/pi-devin   # removes the package
```

`pi update npm:@buyong/pi-devin`은 이 패키지만 업데이트하며, 대상 없이 `pi update`만 실행하면 Pi 자체를 업데이트합니다. `npm:@buyong/pi-devin@0.1.0`처럼 정확한 버전으로 설치했다면 `pi update`가 `Updated`를 출력해도 그 버전을 유지합니다. 다른 버전으로 바꾸려면 `pi install npm:@buyong/pi-devin@<version>`으로 직접 설치합니다. 프로젝트 설치를 지우려면 그 프로젝트 안에서 `pi remove npm:@buyong/pi-devin -l`을 실행합니다.

로그아웃하려면 Pi에서 `/logout` → Devin을 실행합니다. 이 기기의 로그인 데이터만 지우며, 서버의 세션은 끝내지 않습니다.

다른 계정으로 로그인하면, 이전 계정으로 쓰던 세션은 대화를 새 계정으로 보내지 않고 오류를 반환합니다. 새 Pi 세션을 시작하세요.

## CLI(선택)

이 저장소에는 Pi 없이 로그인과 대화를 확인하는 CLI(`cli.ts`)가 있습니다. Pi에서 패키지를 쓰는 데는 필요하지 않습니다.

CLI는 npm 패키지에 들어 있지 않습니다. 소스 체크아웃에서 실행합니다.

```bash
git clone https://github.com/buYoung/pi-packages.git
cd pi-packages
pnpm --filter @buyong/pi-devin install --frozen-lockfile --ignore-scripts
cli=apps/pi-devin/cli.ts
node "$cli" --help
node "$cli" login            # browser login; opening the browser automatically works only on macOS
node "$cli" status
node "$cli" models
node "$cli" chat --model swe-2-medium --prompt "Please say hello briefly." \
  --allow-model-calls --no-title --no-analytics
```

- `chat`은 `--allow-model-calls`가 있을 때만 모델을 호출합니다. 기본적으로 Devin CLI처럼 제목 생성 요청과 분석 이벤트도 보냅니다. `--no-title`과 `--no-analytics`로 끕니다.
- `login`이 브라우저를 자동으로 여는 것은 macOS에서만 동작합니다. 브라우저를 열 수 없으면 `login --force-manual-token-flow --no-browser`로 코드를 직접 입력합니다.
- CLI 로그인 데이터는 Pi와 별도로 `~/.local/share/devin-protocol-poc/`에 저장합니다. 위치는 `DEVIN_POC_STATE_DIR`로 바꿉니다.

## 테스트한 환경

| 항목 | 테스트한 버전·범위 |
| --- | --- |
| Pi | 1.4.0과 1.3.0 |
| Node.js | 22.19.0, 24.14.0 |
| OS | macOS arm64. Linux arm64는 Pi 1.3.0에서 자동 테스트만 통과(실제 Pi 화면과 실제 계정은 확인하지 않음) |
| 실제 계정 | SWE-2 모델로 로그인, 모델 목록, 대화, 추론 수준 변경, 도구 호출, Fusion, 권장 모델 필터, RPC 모드의 `/devin` 알림에 나오는 사용량 한도와 사용량(Pi 1.3.0, 2026-10-20). 도구와 추론 없이 SWE-2 대화 요청 한 건(Pi 1.4.0, 2026-10-29) |

TUI 전용 화면(`/devin` 화면, 상태 표시줄, Fusion 선택 화면)은 실제 계정으로 확인하지 않았습니다. Pi 1.4.0에서는 실제 계정의 전체 항목과 Linux를 다시 확인하지 않았습니다. 다른 Pi 버전과 Windows도 확인하지 않았습니다.

## 개발

소스와 검증 절차는 [GitHub 저장소](https://github.com/buYoung/pi-packages/tree/main/apps/pi-devin)에 있습니다. 개발 의존성을 설치한 소스 체크아웃의 `apps/pi-devin/`에서 다음을 실행합니다. 로컬 fixture를 쓰므로 Devin 계정이 필요 없습니다.

```bash
pnpm run typecheck
pnpm run test:unit
node verification/scripts/import-closure.mjs . --expect verification/inventory.json
```

기대 결과: 종료 코드 0, 모든 테스트 통과, import-closure 문제 없이 `ok: true`. 보조 모델 테스트는 취소, 하위 프로세스 연결 끊김, 한 번만 전달, 보고 한도를 다룹니다. 격리된 Pi와 압축 파일 검사는 [`verification/README.md`](https://github.com/buYoung/pi-packages/blob/main/apps/pi-devin/verification/README.md)를, 스키마 소스는 [`proto/README.md`](proto/README.md)를 참고하세요.

## 스키마 출처와 라이선스

이 패키지의 코드는 MIT 라이선스입니다([LICENSE](LICENSE)).

`proto/`에 포함한 프로토콜 스키마는 제3자 저장소 [leookun/devin-2api](https://github.com/leookun/devin-2api)가 Devin CLI에서 추출했다고 밝힌 descriptor를 바탕으로 합니다. 이 패키지는 그 뒤 프로토콜을 직접 분석해 원래 descriptor에 없는 정의 네 개를 추가했습니다. 추가한 정의는 소스에 `[added field]`/`[added value]`로 표시하고 [`proto/README.md`](proto/README.md)에 정리했습니다. 런타임은 `proto/`를 직접 로드합니다.

leookun/devin-2api는 MIT License로 배포되며, 그 라이선스가 요구하는 대로 고지를 아래에 그대로 싣습니다. 이 라이선스는 leookun의 저작물에 적용되며, leookun이 Devin CLI에서 추출했다고 밝힌 스키마의 저작권과 배포 권리는 확인하지 않았습니다.

```text
MIT License

Copyright (c) 2026 leookun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
