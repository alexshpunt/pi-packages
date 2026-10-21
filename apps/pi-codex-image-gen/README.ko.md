# @buyong/pi-codex-image-gen

[English](README.md) | **한국어**

Pi 대화에서 새 이미지를 만들거나 참조 이미지를 편집합니다. Codex 호환 `image_gen` 도구와 `imagegen` 스킬을 제공하며 이미지 요청에는 Pi의 `openai-codex` ChatGPT 구독 인증을 사용합니다. 대화 공급자·모델은 바꾸지 않습니다.

## 요구 사항

- Node.js 22.19 이상과 Pi 1.0.0 이상
- Pi의 `openai-codex` 공급자로 로그인한 ChatGPT Plus 또는 Pro 구독. 계정을 쓸 수 있는지와 실제 이미지 모델 지원은 백엔드 응답에 따라 달라집니다.
- 편집용: 읽을 수 있는 로컬 참조 이미지나, 모델이 볼 수 있는 대화에 남아 있는 이미지

OpenAI API 키만으로는 이 확장의 구독 인증 정보를 제공할 수 없습니다. 프롬프트와 참조 이미지는 이미지 백엔드에 전송합니다. 전송할 권한이 있는 데이터만 사용하세요.

## 빠른 시작: 이미지 생성

`@buyong/pi-codex`를 이미 쓴다면 이 확장이 포함되어 있으므로 따로 설치하거나 활성화하지 마세요. 그렇지 않다면 게시된 릴리스를 설치하고 Pi를 시작합니다.

```sh
pi install npm:@buyong/pi-codex-image-gen
pi list
pi
```

`pi list`는 `User packages:` 아래에 `npm:@buyong/pi-codex-image-gen`와 설치 경로를 표시합니다.

Pi 안에서 로그인합니다.

```text
/login openai-codex
```

확장은 사용자 요청마다 먼저 로그인 상태를 확인합니다. 유효한 구독 로그인이 없으면 도구와 스킬을 숨깁니다. 로그인하면 확장이 숨긴 도구와 스킬을 다음 요청 전에 되돌립니다. 사용자가 직접 끈 도구는 꺼진 채로 남고, 그동안 스킬도 숨겨집니다. 대화 모델은 그대로 두세요.

필요하면 생성 전에 `/codex-imagen`으로 이미지 모델을 확인·변경합니다. 저장한 선택이 없으면 `gpt-image-2.5`를 사용합니다. 그다음 요청합니다.

```text
Use image_gen to create a watercolor illustration of a small cafe on a rainy street.
```

성공하면 결과에 PNG 이미지를 포함합니다. 대화형 터미널에서는 이미지 크기를 담은 요약을 표시하고, 터미널이 인라인 이미지를 지원할 때만 그 아래에 이미지를 그립니다([생성 이미지 보기](#생성-이미지-보기) 참고). 로컬 복사본 저장은 별개이며 실패할 수 있습니다. [출력과 저장](#출력과-저장)을 참고하세요. 결과 대신 도구 오류가 나오면 요청이 실패했거나 이미지 데이터가 없는 것이므로, 파일이 생겼다고 가정하지 말고 오류 내용을 확인합니다.

서로 독립적인 이미지를 여러 장 요청하면 번들 스킬이 모델에게 한 응답에서 함께 호출하도록 안내하고, Pi는 그 호출들을 병렬로 실행합니다. 모델이 여전히 한 장씩 호출할 수 있으며, 이미지마다 구독 백엔드에 별도 요청이 갑니다.

## 로컬·대화 이미지 편집

편집 요청 전에 출처를 선택합니다.

- **로컬 파일:** Pi가 읽을 수 있는 이미지의 절대 경로나 `~/`로 시작하는 경로를 제공합니다.
- **대화 이미지:** 이미지를 첨부하거나, 현재 모델이 볼 수 있는 대화에 남겨 둡니다. 문맥이 바뀌어 빠진 이미지는 자동으로 복구하지 않습니다.

로컬 파일은 다음과 같이 요청합니다.

```text
Use image_gen to edit /absolute/path/to/product.png. Remove the background and keep the product unchanged with a transparent background.
```

예시 경로를 실제 파일로 바꾸세요. 투명 배경이 필요하면 명시적으로 요청합니다. 한 번의 편집에 참조 이미지를 최대 5개 사용할 수 있습니다.

| 도구 인자 | 동작 |
| --- | --- |
| `prompt` | 생성할 이미지나 편집 내용. 필수입니다. |
| `transparent_background` | 불리언. 기본값은 `false`입니다. |
| `referenced_image_paths` | 로컬 절대 경로 최대 5개. `~/`는 홈 디렉터리로 확장합니다. |
| `num_last_images_to_include` | 현재 모델이 볼 수 있는 대화의 최근 이미지 1~5개 사용 |

모델이 요청에 맞춰 이 인자를 정합니다. 로컬 파일은 `referenced_image_paths`, 대화 이미지는 `num_last_images_to_include`를 쓰고, 새 이미지에는 둘 다 쓰지 않습니다. 한 호출에 두 참조 인자를 함께 쓸 수는 없습니다. 알 수 없는 필드, 잘못된 타입·개수와 참조 선택 충돌은 요청 전에 거부합니다.

로컬 참조는 일반 파일이어야 하며 디렉터리·파이프·장치 경로는 거부합니다. PNG·JPEG·WebP는 디코딩 검증 후 원래 바이트를 유지합니다. 다른 형식은 Pi가 디코딩할 수 있으면 PNG로 변환합니다. 취소 신호는 파일 읽기에 전달하고 각 변환 전후에 확인하지만, 이미 실행 중인 변환 자체는 중단할 수 없습니다. 최근 대화 이미지는 기록된 그대로 시간순으로 전송합니다. 요청한 개수보다 문맥에 남은 이미지가 적으면 무관한 파일을 고르지 않고 오류를 반환합니다.

## 이미지 모델 선택

`/codex-imagen`에서 **`gpt-image-2.5`**(기본값)나 **`gpt-image-2`**를 선택합니다. 대화 모델이 아니라 이미지 백엔드 모델 설정입니다. 취소하면 현재 선택을 유지합니다. UI가 없으면 아래 대안 중 하나를 실행합니다.

```text
/codex-imagen gpt-image-2.5
/codex-imagen gpt-image-2
```

설정 경로는 `<agentDir>/codex-image-gen/settings.json`입니다. `agentDir`은 `PI_CODING_AGENT_DIR`을 따르며 보통 `~/.pi/agent`입니다.

```json
{
  "model": "gpt-image-2.5"
}
```

선택은 저장하고 이후 생성·편집과 Pi 재시작 후에도 적용합니다. 요청마다 파일을 다시 읽으므로 직접 편집해도 `/reload` 없이 적용합니다. 파일이나 `model`이 없으면 기본값을 사용합니다. 잘못됐거나 읽을 수 없으면 오류를 반환하며 다른 모델을 임의로 선택하지 않습니다. `/codex-imagen`으로 저장할 때 다른 설정 키는 그대로 둡니다.

이 모델명은 구독 백엔드에 전달합니다. 선택창에 있다는 이유만으로 계정·백엔드의 지원을 확인할 수는 없습니다.

## 출력과 저장

백엔드 응답의 첫 이미지를 PNG 이미지 콘텐츠로 반환하고 다음 위치에 저장을 시도합니다.

```text
<agentDir>/generated_images/<sessionId>/<toolCallId>.png
```

세션 ID와 도구 호출 ID에서 파일명에 쓸 수 없는 문자는 바꿉니다. 저장에 실패해도 도구는 이미지를 그대로 반환합니다. 대화 문맥에서 빠진 뒤에도 편집하려면 저장된 파일의 복사본을 두세요.

저장 이미지는 자동 삭제하지 않습니다. 기본 에이전트 디렉터리에서는 `~/.pi/agent/generated_images/`에 계속 남으며, `PI_CODING_AGENT_DIR`을 설정하면 그 아래에 저장합니다. macOS·Linux에서는 다음 명령으로 디스크 사용량을 확인합니다.

```sh
du -sh "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/generated_images"
```

정리하려면 필요한 이미지를 먼저 복사한 뒤 파일 관리자에서 `generated_images` 디렉터리의 불필요한 PNG 파일이나 세션 하위 디렉터리를 직접 삭제하세요. 이 작업은 Pi 세션 기록에 이미 남은 이미지 데이터까지 지우지는 않습니다.

인증을 확인할 수 없거나 참조 이미지를 로드할 수 없는 경우, 잘못된 설정, 백엔드 실패, 이미지 데이터 부재·빈 데이터·잘못된 base64에는 오류를 반환합니다. 성공 응답 본문은 base64와 JSON을 합쳐 128 MiB까지 허용하며, 초과하면 수신을 중단하고 재시도 없이 오류를 반환합니다. HTTP 오류 본문이 16 KiB를 넘으면 상태 코드는 유지하고 본문은 생략합니다. 백엔드 오류 텍스트는 비밀값을 치환한 뒤 4 KiB로 제한하며 줄였다는 안내를 붙입니다. 호출자의 취소 신호를 이미지 요청과 응답 읽기에 전달하지만, 취소만으로 원격 서비스가 이미 작업했는지 알 수는 없습니다.

SDK·도구 호출자 참고: 저장에 성공하면 `details.savedPath`에 경로가 들어 있습니다. 경로를 담은 모델용 텍스트 안내는 1,024바이트를 넘으면 빼며, 이는 경로가 매우 길 때만 생깁니다.

## 생성 이미지 보기

대화형 터미널에서는 `image_gen` 호출마다 요청 내용(작업 종류, 배경, 프롬프트)을 보여 줍니다. 프롬프트는 항목을 펼치기 전까지 한 줄로 줄여 보여 줍니다. 성공하면 모델이 받는 텍스트 안내 대신 이미지 크기, 저장 경로, 보는 방법을 요약해 표시합니다. 터미널이 인라인 이미지(Kitty 그래픽 또는 iTerm2 프로토콜)를 지원하면 Pi가 요약 아래에 이미지를 그립니다.

- **이미지 확대:** 이미지를 클릭합니다. 터미널 높이에 맞는 가장 큰 크기로 커지고, 다시 클릭하면 Pi의 이미지 폭(`terminal.imageWidthCells`)으로 돌아갑니다. 이미지마다 따로 확대됩니다. Pi가 마우스 클릭을 받는 기본 `fullscreen` 모드에서 동작합니다. `regular` 모드에서는 터미널이 클릭을 처리하므로 확대되지 않습니다.
- **저장 파일 열기:** 경로를 클릭합니다. 경로는 OSC 8 링크입니다. `fullscreen` 모드에서는 Pi가 OS의 기본 앱으로 열고, `regular` 모드에서는 터미널이 엽니다(터미널에 따라 Cmd나 Ctrl을 함께 눌러야 함). Pi가 터미널의 OSC 8 링크 지원을 감지하지 못하면, `fullscreen` 모드에서 경로를 클릭할 때 확장이 직접 파일을 엽니다. macOS는 `open`, Linux는 `xdg-open`, Windows는 `rundll32 url.dll,FileProtocolHandler`를 사용합니다. 단, SSH 세션(`SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` 중 하나가 있음)에서는 앱이 원격 컴퓨터에서 열리므로 열지 않고, `DISPLAY`와 `WAYLAND_DISPLAY`가 모두 없는 Linux와 기타 Unix에서는 보여 줄 화면이 없으므로 열지 않습니다.

## 문제 해결

| 증상 | 조치 |
| --- | --- |
| 도구가 숨겨졌거나 구독 인증 정보가 없음 | `/login openai-codex`로 다시 로그인합니다. 대화 모델은 유지하세요. `--tools`, `--exclude-tools`, `--no-tools`나 Pi의 `defaultTools` 설정으로 직접 끈 도구는 확장이 다시 켜지 않으므로, `image_gen`을 켜고 Pi를 시작합니다. |
| 잘못된 이미지 모델 설정 | `<agentDir>/codex-image-gen/settings.json`(오류에 표시된 경로)의 `model`을 `gpt-image-2.5`나 `gpt-image-2`로 고칩니다. 다음 요청이 파일을 다시 읽습니다. |
| 로컬 참조를 읽거나 디코딩할 수 없음 | 경로가 절대 경로(또는 `~/`로 시작)인지, 파일을 읽을 수 있는지, 유효한 PNG·JPEG·WebP나 Pi가 디코딩할 수 있는 형식인지 확인합니다. |
| 요청한 최근 이미지가 없음 | 다시 첨부하거나 저장한 로컬 경로를 사용합니다. 현재 모델이 볼 수 있는 대화 밖의 이미지는 자동으로 복구하지 않습니다. |
| 백엔드가 모델·계정을 거부함 | 계정 접근과 반환 오류를 확인합니다. 다른 모델로 대체하거나 API 키를 구독 인증 대신 사용하지 않습니다. |
| 이미지 대신 텍스트 표시만 나옴 | Pi는 tmux 안에서 인라인 이미지를 끄고, Windows Terminal·VS Code·Alacritty·JetBrains 터미널은 이미지 지원 터미널로 감지하지 않습니다. 저장 경로로 엽니다. 터미널이 Kitty나 iTerm2 이미지를 지원하면 Pi의 `settings.json`(기본 `~/.pi/agent/settings.json`)에서 `terminal.images`를 `"kitty"`나 `"iterm2"`로 지정합니다. |
| 이미지를 클릭해도 확대되지 않음 | Pi 기본 `fullscreen` 모드를 사용합니다. Pi의 `settings.json`에서 `"tuiMode": "regular"`를 지우거나 `--tui-mode fullscreen`으로 시작하세요. `regular` 모드에서는 Pi가 마우스 클릭을 받지 않습니다. 터미널 높이가 낮아 더 키울 수 없으면 크기를 유지합니다. |
| 경로를 클릭해도 열리지 않음 | 경로 아래에 상태 줄이 있으면 확인합니다. SSH나 그래픽 화면이 없는 환경에서는 앱을 실행하지 않습니다. Linux에서는 `xdg-open`(xdg-utils)을 설치합니다. |

## 소스 빌드와 로드

[pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter @buyong/pi-codex-image-gen typecheck
pnpm --filter @buyong/pi-codex-image-gen lint
pnpm --filter @buyong/pi-codex-image-gen build
pnpm --filter @buyong/pi-codex-image-gen exec pi -ne -e ./dist/index.js --skill ./skills
```

`--skill ./skills`는 이번 실행에 번들 `imagegen` 스킬을 로드합니다. `-ne`는 자동 확장 탐색을 끕니다. 소스를 바꾼 뒤 다시 빌드하세요. 소스 실행도 Pi 구독 로그인이 필요합니다. 빌드가 이미지를 생성하거나 실제 계정 접근을 확인하지는 않습니다.

이 소스 실행에서는 이미지 클릭 확대가 동작하지 않습니다. 패키지 디렉터리에서 로드하면 확장이 실행 중인 Pi 대신 `node_modules`의 개발용 Pi 패키지 사본을 가져오므로, 클릭 처리가 다른 클래스에 연결됩니다. 소스에서 확대를 확인하려면 `node_modules`가 없는 패키지 사본을 로드합니다.

```sh
cd apps/pi-codex-image-gen
mkdir -p /tmp/pi-codex-image-gen-try
npm pack --ignore-scripts --pack-destination /tmp/pi-codex-image-gen-try
tar xzf /tmp/pi-codex-image-gen-try/*.tgz -C /tmp/pi-codex-image-gen-try
pi -ne -e /tmp/pi-codex-image-gen-try/package/dist/index.js --skill /tmp/pi-codex-image-gen-try/package/skills
```

패키지 준비는 [저장소 배포 절차](https://github.com/buYoung/pi-packages/blob/main/README.ko.md#공통-ci와-패키지별-배포)를 참고하세요.

## 라이선스

코드는 [Apache-2.0](LICENSE)이며 압축 파일에 `LICENSE`로 포함합니다. 수정한 Codex 스킬의 [라이선스](skills/imagegen/LICENSE.txt)와 [출처 고지](skills/imagegen/NOTICE)도 있습니다.
