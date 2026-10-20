# @buyong/pi-codex-image-gen

[English](README.md) | **한국어**

Pi 대화에서 새 이미지를 만들거나 참조 이미지를 편집합니다. Codex 호환 `image_gen` 도구와 `imagegen` 스킬을 제공하며 이미지 요청에는 Pi의 `openai-codex` ChatGPT 구독 인증을 사용합니다. 대화 공급자·모델은 바꾸지 않습니다.

## 요구 사항

- Node.js 22.19 이상과 Pi 1.0.0 이상
- Pi의 `openai-codex` 공급자를 통한 유효한 ChatGPT Plus/Pro 구독 로그인. 계정 이용 가능 여부와 실제 이미지 모델 지원은 백엔드 응답에 따라 달라집니다.
- 편집할 때는 읽을 수 있는 로컬 참조 이미지나 모델이 볼 수 있는 대화에 남은 이미지

OpenAI API 키만으로는 이 확장의 구독 인증 정보를 제공할 수 없습니다. 프롬프트와 참조 이미지는 이미지 백엔드에 전송합니다. 전송할 권한이 있는 데이터만 사용하세요.

## 빠른 시작: 이미지 생성

게시된 릴리스를 설치하고 Pi를 시작합니다.

```sh
pi install npm:@buyong/pi-codex-image-gen
pi list
pi
```

`@buyong/pi-codex`를 통해 같은 확장을 함께 활성화하지 마세요. Pi 안에서 로그인합니다.

```text
/login openai-codex
```

사용자 요청 전에 로그인을 확인합니다. 유효한 구독 로그인이 없으면 도구·스킬을 숨깁니다. 로그인 후 다음 요청 전에 확장이 숨긴 도구를 복원하지만 직접 끈 도구는 유지합니다. 대화 모델은 그대로 두세요.

필요하면 생성 전에 `/codex-imagen`으로 이미지 모델을 확인·변경합니다. 저장한 선택이 없으면 `gpt-image-2.5`를 사용합니다. 그다음 요청합니다.

```text
Use image_gen to create a watercolor illustration of a small cafe on a rainy street.
```

성공하면 결과에 PNG 이미지를 포함합니다. 로컬 복사본 저장은 별개이며 실패할 수 있습니다. [출력과 저장](#출력과-저장)을 참고하세요. 이미지가 없다면 요청 실패나 데이터 부재이므로 파일이 생겼다고 가정하지 말고 도구 오류를 확인합니다.

## 로컬·대화 이미지 편집

편집 요청 전에 출처를 선택합니다.

- **로컬 파일:** Pi가 읽을 수 있는 이미지의 절대 경로를 제공합니다.
- **대화 이미지:** 첨부하거나 현재 모델 문맥에 유지합니다. 문맥 변경으로 빠진 이미지는 자동 복구하지 않습니다.

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

모델이 요청에 맞춰 참조 인자를 선택합니다. 로컬 파일은 `referenced_image_paths`, 대화 이미지는 `num_last_images_to_include`를 사용하며 둘을 함께 쓰지 않습니다. 새 이미지에는 둘 다 생략합니다. 알 수 없는 필드, 잘못된 타입·개수와 참조 선택 충돌은 요청 전에 거부합니다.

로컬 PNG·JPEG·WebP는 디코딩 검증 후 원래 바이트를 유지합니다. 다른 형식은 Pi가 디코딩할 수 있으면 PNG로 변환합니다. 최근 대화 이미지는 기록된 그대로 시간순으로 전송합니다. 요청한 개수보다 문맥에 남은 이미지가 적으면 무관한 파일을 고르지 않고 오류를 반환합니다.

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

선택은 저장하고 이후 생성·편집과 Pi 재시작 후에도 적용합니다. 요청마다 파일을 다시 읽으므로 직접 편집해도 `/reload` 없이 적용합니다. 파일이나 `model`이 없으면 기본값을 사용합니다. 잘못됐거나 읽을 수 없으면 오류를 반환하며 다른 모델을 임의로 선택하지 않습니다. 명령 저장은 다른 설정 키를 보존합니다.

이 모델명은 구독 백엔드에 전달합니다. 선택창에 있다는 이유만으로 계정·백엔드의 지원을 확인할 수는 없습니다.

## 출력과 저장

백엔드 응답의 첫 이미지를 PNG 이미지 콘텐츠로 반환하고 다음 위치에 저장을 시도합니다.

```text
<agentDir>/generated_images/<sessionId>/<toolCallId>.png
```

세션·도구 호출 이름은 파일명에 맞게 정리합니다. 저장에 실패해도 반환 이미지는 버리지 않습니다. SDK·도구 호출자는 `details.savedPath`로 저장 성공을 확인할 수 있습니다. 경로가 매우 길면 텍스트 안내는 생략할 수 있습니다. 대화 문맥에서 빠진 뒤에도 편집할 수 있도록 로컬 복사본을 유지하세요.

인증을 확인할 수 없거나 참조 이미지를 로드할 수 없는 경우, 잘못된 설정, 백엔드 실패와 이미지 데이터 부재에는 오류를 반환합니다. 호출자의 취소 신호를 이미지 요청에 전달하지만, 취소만으로 원격 서비스가 이미 작업했는지 알 수는 없습니다.

## 문제 해결

| 증상 | 조치 |
| --- | --- |
| 도구가 숨겨졌거나 구독 인증 정보가 없음 | `/login openai-codex`로 다시 로그인합니다. 대화 모델은 유지하세요. 직접 끈 도구는 직접 다시 켭니다. |
| 잘못된 이미지 모델 설정 | 표시된 파일의 `model`을 `gpt-image-2.5`나 `gpt-image-2`로 설정합니다. 다음 요청이 다시 읽습니다. |
| 로컬 참조를 읽거나 디코딩할 수 없음 | 절대 경로, 파일 권한과 이미지 디코딩 지원을 확인합니다. |
| 요청한 최근 이미지가 없음 | 다시 첨부하거나 저장한 로컬 경로를 사용합니다. 현재 모델 문맥 밖의 이미지는 자동 복구하지 않습니다. |
| 백엔드가 모델·계정을 거부함 | 계정 접근과 반환 오류를 확인합니다. 다른 모델로 대체하거나 API 키를 구독 인증 대신 사용하지 않습니다. |

## 소스 빌드와 로드

[pi-packages](https://github.com/buYoung/pi-packages) 저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm --filter @buyong/pi-codex-image-gen build
pnpm --filter @buyong/pi-codex-image-gen exec pi -ne -e ./dist/index.js --skill ./skills
```

명시적 스킬 경로는 이번 실행에 번들 지침을 로드합니다. `-ne`는 자동 확장 탐색을 끕니다. 소스를 바꾼 뒤 다시 빌드하세요. 소스 실행도 Pi 구독 로그인이 필요합니다. 빌드가 이미지를 생성하거나 실제 계정 접근을 확인하지는 않습니다.

패키지 준비는 [저장소 배포 절차](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포)를 참고하세요.

## 라이선스

코드는 [Apache-2.0](LICENSE)이며 압축 파일에 `LICENSE`로 포함합니다. 수정한 Codex 스킬의 [라이선스](skills/imagegen/LICENSE.txt)와 [출처 고지](skills/imagegen/NOTICE)도 있습니다.
