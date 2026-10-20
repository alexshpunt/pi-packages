---
doc-type: Feature Design Doc
profile: full
feature-name: codex-image-gen
status: draft
created: 2026-10-05
last-verified: 2026-10-05
verified-against: unverified
tags: [image_gen, imagegen, image generation, gpt-image-2, openai, codex, pi extension]
related: []
purpose: Source of design decisions, not implementation actions
agent-readable: true
not:
  - task list
  - PR checklist
  - file-level change guide
---

# Codex image_gen Pi 확장 Feature Design Doc

## 1. Document Intent

이 문서는 Codex의 `image_gen` 도구를 Pi 확장으로 옮기는 기능의 설계 결정 기준입니다. 도구 계약, 요청 규칙, 저장 규칙, 실패 처리 같은 제품 동작과 그 근거를 정의합니다. 구현 순서, 작업 목록, 파일별 변경 지시는 다루지 않습니다.

- **상태**: 초안(draft)입니다. 사용자가 정해야 할 설계 결정은 모두 정해졌습니다. 다만 이 문서를 현재 설계 기준으로 확정(active)한다는 승인은 아직 받지 않았습니다. 실제 호출로 확인해야 할 위험은 [13. Risks & Open Questions](#13-risks--open-questions)에 남아 있습니다.
- **결정 권한**:
  - 다음 결정은 사용자가 정했습니다.
    - "Codex의 `image_gen`을 Pi 플러그인으로 만든다"는 방향
    - 이미지 요청에는 Pi `openai-codex`(ChatGPT Plus/Pro) 구독 로그인을 쓰고, 채팅 모델·공급자(예: `openai`)는 그대로 두는 최종 결정. Pi `openai` 토큰은 이미지 요청이 거부돼 사용하지 않습니다([9.1](#91-공급자와-인증-정책), [Revision History](#revision-history)).
    - "저장 위치는 Codex와 동일하게 한다"는 결정([9.7](#97-저장-정책))
    - "자격 증명이 없으면 사용할 수 없고, 사용자가 끈 도구는 다시 켜지 않는다"는 결정([9.9](#99-자격-증명-미설정-시-노출-정책))
    - 도구 설명은 Codex 원문에서 [9.3](#93-도구-설명-정책)의 네 가지만 바꾸고(그중 `python` 문장 삭제는 사용자가 직접 확정), 시스템 프롬프트에는 문구를 넣지 않는 결정
    - Codex `imagegen` 스킬을 Pi에 맞게 고쳐 함께 배포하고 CLI 대체 모드를 빼는 결정([9.10](#910-이미지-생성-스킬-정책))
    - 경로 안내 문구를 Codex 원문 그대로 두는 결정([9.8](#98-경로-안내-정책))
    - 도구 동작을 Codex 구현과 정확히 일치시키고, Pi 패키지는 TypeScript로만 구성한다는 결정([9.11](#911-codex-동일성-원칙))
    - 도구가 숨겨지면 스킬도 함께 숨기는 결정([9.10](#910-이미지-생성-스킬-정책))
  - 사용자 결정과 Pi 런타임 때문에 Codex와 달라지는 부분은 [9.11](#911-codex-동일성-원칙)에 모아 두었습니다.
- **검토 범위**: 최초 초안은 2026-10-05에 Codex 로컬 사본 `tmp/codex-main`, Pi 패키지 0.99.1, 공개 API용 OpenAI SDK 7.19.0을 기준으로 작성하고 독립 검토했습니다. 이후 사용자는 기존 Pi 구독 인증 재사용을 승인했습니다. 이번 부분 수정은 그 결정, 실제 호출 기록, 인증·노출·요청 형식의 구현을 반영합니다. 최초 독립 검토가 이번 구독 경로 변경까지 검증했다는 뜻은 아닙니다.
- **실제 호출 이력**: Pi `openai` 토큰의 이미지 요청은 세 경로 모두 거부됐습니다(`/v1/images/generations` 401, ChatGPT Images 경로 401, `/v1/responses`의 `image_generation` 400). `openai-codex` 로그인을 쓴 최종 패키지는 실제 Pi에서 `openai` 채팅 모델이 `image_gen`을 호출해 1254×1254 PNG를 생성·저장했습니다(`11-openai-codex-image-auth.json`). 실제 편집·투명 배경은 호출하지 않았습니다.
- **구현 검증 범위**: worktree의 미커밋 구현을 빌드와 로컬 검증으로 확인합니다. 정확한 커밋 기준의 문서 전체 구현 적합성은 아직 확인하지 않았으므로 `verified-against`는 `unverified`입니다. `last-verified` 날짜는 최초 설계 검증 날짜를 유지합니다. 공식 웹 문서는 확인하지 않았습니다.

---

## 2. Background / Problem

Pi 0.99.1에는 대화 중에 모델이 이미지를 만들거나 편집하는 도구가 없습니다. pi-ai에 범용 이미지 생성 레지스트리(`generateImages()`)는 있지만, 등록된 이미지 모델은 `openrouter` 공급자뿐이고 OpenAI 이미지 모델은 없습니다.

Codex는 `image_gen.imagegen` 도구로 이 기능을 제공합니다. Codex에서 사용자는 "이 장면을 그려줘", "방금 만든 이미지의 배경을 지워줘" 같은 요청만 하면 되고, 모델이 도구를 골라 이미지를 생성하거나 편집합니다. 결과는 화면에 표시되고 파일로도 저장됩니다.

Codex는 ChatGPT 로그인일 때 이미지 요청을 ChatGPT Images 경로(`chatgpt.com/backend-api/codex/images/*`)로 보냅니다. 이 경로는 Codex 앱 로그인 토큰만 받으며, Pi에서는 `openai-codex` 로그인이 여기에 해당합니다. Pi `openai`(Sign in with ChatGPT) 토큰은 채팅에는 쓰이지만 이미지 요청은 서버가 거부합니다. 인증 정책은 [9.1](#91-공급자와-인증-정책)에 정의합니다.

---

## 3. Feature Definition

```text
Codex image_gen Pi 확장은 채팅 공급자를 바꾸지 않고 기존 Pi ChatGPT 구독 인증으로 이미지를 생성·편집하며, 결과를 화면에 보여 주고 파일로 저장하는 모델 호출용 도구다.
```

### This feature is

- 모델이 스스로 판단해 호출하는 도구입니다. 사용자는 자연어로 요청할 뿐 도구를 직접 실행하지 않습니다.
- 생성과 편집을 함께 담당하는 하나의 도구입니다. 어느 쪽이 될지는 인자에 따라 정해집니다.
- Codex `image_gen`의 사용 경험을 Pi에 옮긴 기능입니다. 인자 이름, 제한값, 오류 문구를 Codex와 맞춥니다.
- Pi가 관리하는 기존 ChatGPT 구독 인증을 재사용하는 기능입니다. 현재 채팅 모델이나 공급자는 바꾸지 않습니다.

### This feature is not

- 이미지 편집기나 그림 그리기 UI가 아닙니다. 마스크 지정이나 영역 선택을 제공하지 않습니다.
- 새 모델 공급자가 아닙니다. Pi의 모델 선택 목록이나 `generateImages()` 레지스트리에 모델을 추가하지 않습니다.
- Codex 전체 기능을 구현하는 클라이언트가 아닙니다. 이미지 도구 계약을 이식하되 Pi의 정식 OpenAI 인증을 사용하고, Codex 전용 사용량 한도 이벤트·요금제 판정·분석 이벤트는 재현하지 않습니다.

---

## 4. Goals & Non-Goals

### Goals

- 모델이 프롬프트만으로 새 이미지를 만들 수 있게 합니다.
- 로컬 파일 경로나 대화 속 최근 이미지를 기준으로 편집할 수 있게 합니다.
- 결과를 TUI에 보여 주고, 같은 이미지를 모델에도 돌려줘 다음 대화에서 이어 쓸 수 있게 합니다.
- 결과를 예측 가능한 경로에 PNG로 저장하고, 그 경로를 모델에게 알려 줍니다.
- Codex에 익숙한 모델과 사용자가 같은 인자, 같은 제한값, 같은 오류 문구를 만나게 합니다.
- 자격 증명이 결과, 오류, 세션 기록 어디에도 남지 않게 합니다.

### Non-Goals

- **품질·크기·모델 선택 노출**: 모델이나 사용자가 품질, 크기, 이미지 모델을 고르게 하지 않습니다. Codex가 이 값을 고정해 도구 사용법을 단순하게 유지하기 때문입니다.
- **한 번에 여러 장 생성**: 한 호출에서 여러 이미지를 만들지 않습니다. Codex도 결과 중 첫 장만 사용합니다.
- **모든 이미지 공급자 지원**: Google·OpenRouter 등 다른 이미지 공급자를 지원하지 않습니다. 별도 인증 유형이나 API 키 대체 실행 경로를 만들지 않고 Pi가 관리하는 `openai-codex` 구독 로그인만 씁니다.
- **Codex 전체 백엔드 계약 재현**: 이미지 요청 주소·헤더·본문은 Codex와 같게 보내지만, Codex 전용 사용량 한도 이벤트와 분석 체계는 재현하지 않습니다.

---

## 5. User Model & Core Concepts

### User Model

사용자는 이 기능을 이렇게 이해합니다.

- "그려 달라고 하면 Pi가 이미지를 만들어 보여 준다."
- "방금 만든 이미지나 내 파일을 고쳐 달라고 할 수 있다."
- "만든 이미지는 정해진 폴더에 파일로 남는다."
- "Pi에 이미 로그인한 ChatGPT 구독 계정으로 쓴다. 이미지용 구독 로그인이 없으면 도구가 보이지 않고, 현재 채팅 모델은 그대로 둔다."

사용자가 몰라도 되는 것은 이렇습니다.

- 생성 요청과 편집 요청이 서로 다른 엔드포인트로 간다는 점
- 이미지 모델 이름, 품질·크기 값
- 대화 이미지를 고르는 순서 규칙

### Core Concepts

| Concept | Meaning |
| ------- | ------- |
| `image_gen` | 모델에 노출되는 도구 이름입니다. |
| 생성(generation) | 참조 이미지 없이 프롬프트만으로 새 이미지를 만드는 호출입니다. |
| 편집(edit) | 참조 이미지 1~5장과 프롬프트로 새 이미지를 만드는 호출입니다. 원본 파일은 바뀌지 않습니다. |
| 참조 이미지 경로 | `referenced_image_paths`로 지정한 로컬 이미지 파일입니다. |
| 최근 대화 이미지 | 현재 세션 분기에서 가장 최근에 등장한 이미지들입니다. `num_last_images_to_include`로 개수를 지정합니다. |
| 저장 파일(artifact) | 결과 이미지를 저장한 PNG 파일입니다. |
| 경로 안내(output hint) | 저장 위치와 그 파일을 다루는 방법을 모델에게 알리는 문구입니다. |
| 이미지 구독 인증 | Pi `openai-codex` 공급자가 관리하는 ChatGPT Plus/Pro 로그인입니다. 로그인·선택·갱신은 Pi에 맡기고, 패키지는 토큰의 계정 ID만 메모리에서 읽습니다. |

---

## 6. Relationship to Existing Features

| Existing Feature | Relationship |
| ---------------- | ------------ |
| Pi `openai-codex` 공급자 | 이미지 인증의 유일한 기준입니다. 기존 로그인·갱신·주소·추가 헤더를 재사용하며 공급자 설정은 바꾸지 않습니다([9.1](#91-공급자와-인증-정책)). |
| Pi `openai` 공급자 | 채팅에는 그대로 씁니다. 이 토큰의 이미지 요청은 서버가 거부하므로 이미지 인증에는 쓰지 않습니다. |
| Pi `/login` | 재사용합니다. 자격 증명을 설정하면 다음 요청부터 도구를 쓸 수 있습니다([9.9](#99-자격-증명-미설정-시-노출-정책)). |
| Pi `read` 도구 | 함께 씁니다. 모델이 아직 보지 못한 로컬 이미지를 편집 전에 확인하는 수단입니다. Codex의 `view_image`를 대신합니다. |
| Pi 도구 결과의 이미지 표시 | 재사용합니다. 결과 이미지를 TUI에 표시하고 모델에 전달합니다. |
| Pi의 비전 미지원 모델 처리 | 영향을 받습니다. 현재 모델이 이미지 입력을 받지 못하면 Pi가 결과 이미지를 `(tool image omitted: model does not support images)` 문구로 바꿉니다. 저장과 경로 안내는 그대로 동작합니다. |
| Pi `images.blockImages` 설정 | 영향을 받습니다. 이 설정을 켜면 Pi가 모델에 가는 이미지를 막으므로 모델은 결과 이미지를 받지 못합니다. 저장과 경로 안내는 그대로 동작합니다. |
| Codex 번들 스킬 `imagegen` | Pi에 맞게 고쳐 재사용합니다. 언제 쓰고 언제 쓰지 않을지와 프롬프트 정리 방법을 모델에게 알려 줍니다([9.10](#910-이미지-생성-스킬-정책)). |
| Pi 스킬 | 재사용합니다. 위 스킬은 Pi 스킬 목록에 올라가고, 작업이 설명과 맞을 때 모델이 읽습니다. `/skill:imagegen`으로 직접 불러올 수도 있습니다. |
| `pi-codex-auto-review` 확장 | 영향을 받습니다. 이 기능은 외부 네트워크를 사용하고 파일을 쓰는 도구로 자신을 표시하므로, 자동 검토 확장이 함께 켜져 있으면 검토 대상이 됩니다. 자동 검토 동작은 바꾸지 않습니다. |
| pi-ai `generateImages()` 레지스트리 | 관계없습니다. 등록된 OpenAI 이미지 모델이 없어 이 기능은 Images API를 직접 호출합니다. |

---

## 7. Primary User Flows

### 7.1 Main Flow

```text
사용자가 "평평한 스타일의 빨간 여우 아이콘 그려줘"라고 요청한다
  -> 모델이 image_gen을 prompt만 넣어 호출한다
  -> 생성 중이라는 진행 상태가 표시된다
  -> 이미지가 TUI에 표시되고 PNG 파일로 저장된다
  -> 모델은 이미지와 저장 경로 안내를 받아 답변을 마무리한다
     (이미지를 Markdown으로 다시 붙이지 않는다)
```

투명 배경이 필요한 요청(배경 제거, 잘라낸 이미지 등)에서는 모델이 `transparent_background: true`를 함께 보냅니다.

### 7.2 Secondary Flow

로컬 파일 편집:

```text
사용자가 "/path/logo.png 배경을 파란색으로 바꿔줘"라고 요청한다
  -> 모델이 아직 보지 않은 파일이면 read로 먼저 확인한다
  -> 모델이 image_gen을 referenced_image_paths: ["/path/logo.png"]로 호출한다
  -> 편집 결과가 표시되고 새 PNG로 저장된다. 원본 파일은 그대로 남는다
```

대화 속 이미지 편집:

```text
사용자가 방금 생성된 이미지를 보고 "모자를 씌워줘"라고 요청한다
  -> 모델이 image_gen을 num_last_images_to_include: 1로 호출한다
  -> 가장 최근 대화 이미지(직전 생성 결과)를 기준으로 편집 결과가 표시·저장된다
```

### 7.3 Failure / Partial Success Flow

```text
자격 증명이 없는 상태에서 사용자가 이미지를 요청한다
  -> 모델에게 image_gen이 보이지 않아 도구를 호출하지 않는다
  -> 구독 로그인이 없으면 사용자가 /login openai-codex로 ChatGPT Plus/Pro 로그인을 한다
     (기존 로그인이 있으면 다시 로그인하거나 API 키를 설정할 필요 없음)
  -> 다음 프롬프트부터 image_gen을 쓸 수 있다

도구가 보이는 동안 구독 자격 증명을 쓸 수 없게 됐다(로그아웃, 토큰 갱신 실패 등)
  -> 요청을 보내지 않고, /login openai-codex를 안내하는 오류를 모델에 돌려준다

인자가 잘못됐다(선택자 둘 다 지정, 경로 6개, 대화 이미지 부족, 읽을 수 없는 파일 등)
  -> 요청을 보내지 않고, Codex와 같은 오류 문구를 모델에 돌려준다(9.6)

OpenAI가 오류를 반환했다
  -> "image generation failed: " 뒤에 HTTP 상태와 원인을 붙인 오류를 모델에 돌려준다

사용자가 생성 중 Esc로 중단했다
  -> 요청이 취소되고 파일은 저장되지 않으며 Pi는 계속 응답한다

이미지는 받았지만 파일 저장에 실패했다
  -> 이미지는 그대로 표시되고 모델에도 전달된다. 경로 안내만 빠진다
```

각 상태의 정의는 [15. Result Semantics](#15-result-semantics), 판단 규칙은 [9. Policy Decisions](#9-policy-decisions)를 따릅니다.

---

## 8. Design

### 8.1 Behavior

**도구 계약.** 이미지용 구독 인증이 설정됐을 때만 모델에 도구 하나가 보입니다([9.9](#99-자격-증명-미설정-시-노출-정책)). 인자 정의는 [9.2](#92-인자-계약-정책)를, 설명 문구는 [9.3](#93-도구-설명-정책)을 따릅니다.

**요청 종류 결정.** 인자 조합에 따라 생성, 편집, 거부 중 하나가 됩니다([9.4](#94-요청-라우팅-정책)). 이 판단과 모든 인자 검증은 네트워크 요청 전에 끝납니다.

**이미지 요청.** 생성과 편집은 Codex와 같은 ChatGPT Images 경로(`{base}` = `openai-codex` 기준 주소 + `/codex`)에 보냅니다. 인증·헤더는 [9.1](#91-공급자와-인증-정책), 본문은 [9.5](#95-요청-값-정책)을 따릅니다. 다른 공급자나 API 키 경로로 자동 전환하지 않습니다.

- 생성: `POST {base}/images/generations`
- 편집: `POST {base}/images/edits`
- 채팅 모델·공급자 설정은 유지합니다.

**응답 처리.** Codex와 같이 응답의 `data[0].b64_json`만 결과로 씁니다. 나머지 이미지와 메타데이터는 결과에 쓰지 않습니다.

- `data`가 빈 배열이면 실패입니다(`image generation returned no image data`).
- `data` 필드 자체가 없거나 응답을 해석할 수 없으면 응답 해석 오류로 실패합니다([9.6](#96-오류-문구-정책)).
- `b64_json`이 빈 문자열이면 Codex와 같이 성공으로 처리합니다. 이 경우 빈 저장 파일과 빈 이미지 결과가 나옵니다([13](#13-risks--open-questions)).

**재시도.** Codex 공급자 기본 재시도 정책을 따릅니다([9.11](#911-codex-동일성-원칙)). 재시도는 사용자에게 따로 표시하지 않고, 최종 결과만 전달합니다.

**결과 전달.** 성공 결과에는 두 가지가 담깁니다.

- `image/png` 이미지 블록 하나
- 저장에 성공했다면 경로 안내 문구 하나([9.8](#98-경로-안내-정책))

Pi는 이 이미지를 TUI에 표시하고 모델 문맥에 넣습니다. 결과의 부가 정보(details)에는 저장 경로, 요청 종류, 배경 값처럼 작은 값만 담고 base64 데이터는 넣지 않습니다.

**저장.** 성공한 이미지는 PNG 파일 하나로 저장합니다([9.7](#97-저장-정책)). 저장 실패는 결과를 실패로 바꾸지 않습니다.

**진행 표시와 취소.** 요청을 보내기 직전에 "생성 중" 진행 상태를 표시합니다. Pi가 넘겨주는 취소 신호를 요청에 연결해, 사용자가 중단하면 요청을 끊고 파일을 쓰지 않습니다. Codex 도구 설명("imagegen needs a few minutes to finish.")대로 생성에는 몇 분이 걸릴 수 있으므로, 별도 시간 제한을 두더라도 이보다 짧으면 안 됩니다. 통신 계층의 기본 대기 시간이 이보다 짧을 수 있는 위험은 [13](#13-risks--open-questions)에 적습니다.

**세션 기록.** Pi는 도구 결과를 세션 파일에 저장하므로 결과 이미지(base64)도 세션 기록에 남습니다. Codex도 생성 결과를 대화 기록에 남기며, 이 기능은 그 방식을 그대로 따릅니다.

### 8.2 Conceptual Data Model

| Entity | Meaning |
| ------ | ------- |
| 도구 호출 | 모델이 보낸 `image_gen` 호출 하나입니다. Pi가 부여한 호출 ID를 가집니다. |
| 이미지 요청 | 생성 요청 또는 편집 요청입니다. 편집 요청은 참조 이미지 목록을 가집니다. |
| 참조 이미지 | MIME 형식과 base64 데이터를 가진 이미지입니다. 출처는 로컬 파일이거나 세션 기록입니다. |
| 이미지 결과 | 응답의 첫 이미지(PNG base64)입니다. |
| 저장 파일 | 결과를 저장한 PNG 파일입니다. 세션 ID와 호출 ID로 위치가 정해집니다. |

| Field | Meaning |
| ----- | ------- |
| `prompt` | 생성·편집 지시문입니다. |
| `transparent_background` | 투명 배경 요청 여부입니다. 요청의 `background` 값으로 바뀝니다. |
| `referenced_image_paths` | 편집 대상 로컬 파일 경로 목록입니다. |
| `num_last_images_to_include` | 편집 대상으로 쓸 최근 대화 이미지 개수입니다. |
| `savedPath` | 결과 부가 정보에 담는 저장 파일 경로입니다. 저장에 실패하면 없습니다. |

### 8.3 Failure Handling

| 실패 범주 | 처리 | 네트워크 요청 | 저장 |
| --- | --- | --- | --- |
| 인자 오류 | Codex와 같은 문구로 오류를 돌려줍니다([9.6](#96-오류-문구-정책)). | 보내지 않음 | 없음 |
| 참조 파일 읽기·처리 오류 | 해당 경로를 포함한 오류를 돌려줍니다([9.6](#96-오류-문구-정책), [9.4](#94-요청-라우팅-정책)). | 보내지 않음 | 없음 |
| 대화 이미지 부족 | 요청 개수와 실제 개수를 포함한 오류를 돌려줍니다. | 보내지 않음 | 없음 |
| 자격 증명 없음 | 평소에는 도구가 노출되지 않습니다([9.9](#99-자격-증명-미설정-시-노출-정책)). 노출된 상태에서 호출 시점에 구독 자격 증명(계정 ID 포함)을 쓸 수 없으면 `/login openai-codex`를 안내하는 오류를 돌려줍니다([9.1](#91-공급자와-인증-정책)). | 보내지 않음 | 없음 |
| 로그인 토큰 갱신 실패 | 저장된 로그인이 있으면 도구는 노출되지만, 호출 시점에 만료된 토큰을 갱신하지 못하면 자격 증명 없음과 같은 안내 오류를 돌려줍니다([9.1](#91-공급자와-인증-정책)). | 보내지 않음 | 없음 |
| OpenAI HTTP 오류·통신 오류 | 재시도 대상이면 재시도하고, 최종 실패는 [9.6](#96-오류-문구-정책)의 Codex 문구로 돌려줍니다. | 보냄 | 없음 |
| 응답 해석 실패 | [9.6](#96-오류-문구-정책)의 해석 오류 문구로 돌려줍니다. | 보냄 | 없음 |
| 응답에 이미지 없음(`data` 빈 배열) | `image generation returned no image data` 오류를 돌려줍니다. | 보냄 | 없음 |
| 사용자 취소 | 요청을 중단하고 취소로 끝냅니다. | 중단 | 없음 |
| 저장 실패 | 이미지는 성공 결과로 돌려주고 경로 안내만 뺍니다. | 보냄 | 실패 |

어떤 실패도 자격 증명 값을 내용에 포함하지 않습니다([11.1](#111-security)).

---

## 9. Policy Decisions

### 9.1 공급자와 인증 정책

Decision:

- 이미지 요청은 Pi `openai-codex`(ChatGPT Plus/Pro) 구독 로그인으로 인증합니다. 현재 채팅 모델·공급자(예: `openai`)와 사용자 설정은 바꾸지 않습니다.
- 자격 증명은 Pi 모델 레지스트리의 `getProviderAuth("openai-codex")`로만 조회합니다. 로그인·인증 선택·갱신·저장은 Pi에 맡기며, 파일 직접 읽기나 별도 인증 저장소를 만들지 않습니다.
- 토큰의 `https://api.openai.com/auth` 클레임에서 `chatgpt_account_id`를 메모리에서만 읽습니다. Pi의 `openai-codex` 채팅 요청과 같은 방식입니다. 클레임이 없으면 요청 전에 거부합니다.
- 기준 주소는 인증의 base URL, `openai-codex` 공급자의 base URL, 기본값 `https://chatgpt.com/backend-api` 순서로 고르고, 끝의 `/`를 정리한 뒤 `/codex`를 한 번만 붙입니다(Codex `to_api_provider()`의 ChatGPT 인증 주소).
- 헤더: Pi가 준 추가 헤더를 보존하고 `Authorization: Bearer <토큰>`, `chatgpt-account-id`, `originator: pi`(Pi의 `openai-codex` 요청과 같은 값), `x-codex-image-turn-id`(도구 호출 ID), `Content-Type: application/json`을 보냅니다.
- 인증을 얻지 못하거나 갱신에 실패하거나 계정 ID가 없으면 요청 전에 `/login openai-codex`를 안내합니다. 정상적인 기존 로그인에는 재로그인이 필요하지 않습니다.
- Pi `openai` 토큰이나 API 키로 대체하지 않습니다.
- 인증 값과 계정 ID는 결과·로그에 넣지 않습니다. 서버 오류에 반사된 비밀값도 제거합니다.

Rationale:

- Pi `openai` 토큰(Sign in with ChatGPT, `dynamic_agent_client`)으로 이미지 요청을 세 경로에서 실제로 시험했고 모두 거부됐습니다. `/v1/images/generations`는 401 `hardened_oauth_rule_missing`, ChatGPT Images 경로는 401 `no_matching_rule`, `/v1/responses`의 `image_generation`은 400 `subscription_sharing_unsupported_capability`입니다. 토큰에 계정 ID 클레임도 없습니다.
- Codex 앱 로그인 토큰(Pi `openai-codex`)은 Codex와 같은 ChatGPT Images 경로에서 PoC와 최종 패키지 모두 실제 생성에 성공했습니다. 사용자가 이 로그인으로 지원하기로 결정했습니다.

**Superseded decisions (2026-10-05).** 이미지 인증도 Pi `openai`만 쓰고 본문을 공개 Images API 형식으로 보내던 결정(`09` 인계)은 위 거부 결과로 대체했습니다. 과거 기록은 [Revision History](#revision-history)에 보존합니다.

### 9.2 인자 계약 정책

Decision:

| 인자 | 형식 | 필수 | 제한·기본값 |
| --- | --- | --- | --- |
| `prompt` | string | 예 | — |
| `transparent_background` | boolean | 아니오 | 기본 `false` |
| `referenced_image_paths` | string 배열 또는 `null` | 아니오 | 최대 5개 |
| `num_last_images_to_include` | 0 이상 정수 또는 `null` | 아니오 | 1 이상 5 이하 |

- `null`은 값이 없는 것과 같게 취급합니다.
- 도구 이름은 `image_gen`, 표시 이름은 `Image generation`입니다.
- 모델에게 보내는 스키마는 Codex가 실제로 보내는 스키마와 같습니다.
  - 네 필드의 이름과 형식, `prompt` 필수, 정의되지 않은 필드 금지(`additionalProperties: false`)
  - `transparent_background` 설명 "Whether the output should have a transparent background. Defaults to false."
  - 개수 제한(`maxItems`, `minimum`, `maximum`)과 기본값(`default`)은 넣지 않습니다. Codex는 스키마를 만들 때 이 값들을 생성하지만, 도구 스키마 타입에 해당 필드가 없어 모델에 보내기 전에 빠집니다.
- 모든 인자 검사는 Codex와 같은 순서와 문구로 도구가 직접 합니다([9.4](#94-요청-라우팅-정책), [9.6](#96-오류-문구-정책)). Pi의 일반 인자 검사가 먼저 걸려 Pi 문구(`Validation failed for tool ...`)가 나가는 일이 없게 합니다.

Rationale:

- 사용자가 Codex 구현과 정확히 일치시키기로 정했습니다. 인자 이름과 제한값은 Codex `ImagegenArgs`와 같고, 모델이 보는 스키마와 받는 오류도 Codex와 같아야 모델이 같은 방식으로 호출하고 회복합니다.
- Pi는 도구 실행 전에 인자를 스키마로 검사하므로, 제한을 스키마에 두면 Codex 문구 대신 Pi 문구가 나갑니다. Codex가 보내는 스키마에도 제한이 없으므로, 제한을 빼는 것이 동시에 Codex와 일치하는 방법입니다.
- Pi에서 도구를 부르는 이름은 하나의 문자열이고, Codex처럼 `namespace.tool` 형태로 부를 수 없습니다. 그래서 namespace였던 `image_gen`을 도구 이름으로 씁니다.

### 9.3 도구 설명 정책

Decision:

- Codex `imagegen_description.md`의 지침을 그대로 옮기되 다음만 바꿉니다.
  - 도구 이름 `image_gen.imagegen`을 `image_gen`으로 바꿉니다.
  - `view_image`를 Pi의 `read` 도구로 바꿉니다.
  - Codex code-mode 전용 지침(`@exec`, `generatedImage()`, `text()`, `notify()`)은 지웁니다. Pi 0.99.1에도 `codemode`가 있지만 호출 규약이 다르고 `generatedImage()`와 `@exec`가 없습니다.
  - "imagegen needs a few minutes to finish."처럼 위 code-mode 지침과 같은 줄에 있더라도 code-mode와 관계없는 문장은 남깁니다.
  - "Do not use the `python` tool for image editing unless specifically instructed." 문장은 지웁니다. 바로 앞 문장 "Always use this tool for image editing unless the user explicitly requests otherwise."는 그대로 둡니다.
- 유지하는 지침:
  - 사용 시점: 장면 설명으로 생성하거나 첨부·생성 이미지를 수정할 때
  - 투명 배경을 쓰는 조건과 편집 시 기존 투명도 유지
  - 두 선택자 사용 규칙
  - 재확인 없이 바로 생성
  - 사용자가 따로 요청하지 않으면 이미지 편집에 이 도구를 사용
- 이 지침은 도구 설명에만 넣습니다.
- 시스템 프롬프트의 도구 목록 한 줄(`promptSnippet`)과 규칙 절(`promptGuidelines`)에는 이 도구 관련 문구를 넣지 않습니다. 두 항목이 없어도 도구는 정의되고 호출할 수 있습니다.

Rationale:

- 지침이 Codex와 같아야 모델이 같은 상황에서 같은 인자를 고릅니다. 사용자는 Codex에서 이미지 생성이나 시안을 요청하지 않으면 이미지가 만들어지지 않았다고 확인했습니다. 도구 설명의 사용 조건("The user requests an image…", "The user wants to modify…")이 모두 사용자 요청을 전제하므로, 이 문구가 그 동작의 주된 원인일 것으로 봅니다(추론). 그래서 원문을 최대한 유지합니다.
- 존재하지 않는 도구나 함수를 가리키는 지침은 모델이 잘못 호출하거나 지시를 엉뚱하게 해석하게 만듭니다. `python` 문장은 Pi에 없는 도구를 가리키므로 지우고, 이미지 편집에 이 도구를 쓰라는 원래 의도는 남깁니다. 사용자가 이 처리를 확정했습니다.
- Codex는 시스템 프롬프트에 이미지 생성 지침을 두지 않습니다. Pi의 규칙 절에 문구를 넣으면 도구 설명보다 강한 지시로 작동해, 요청할 때만 만드는 Codex의 동작보다 적극적으로 호출할 수 있습니다(추론). 사용 방법 안내는 스킬이 맡습니다([9.10](#910-이미지-생성-스킬-정책)). 사용자가 두 항목을 넣지 않기로 확정했습니다.

### 9.4 요청 라우팅 정책

Decision:

| `referenced_image_paths` | `num_last_images_to_include` | 결과 |
| --- | --- | --- |
| 없음 또는 빈 배열 | 없음 | 생성 |
| 1~5개 | 없음 | 경로 파일로 편집 |
| 없음 또는 빈 배열 | 1~5 | 최근 대화 이미지로 편집 |
| 1개 이상 | 있음 | 거부 |

- 검사 순서는 Codex와 같습니다.
  1. 인자 해석: 정의되지 않은 필드, `prompt` 누락, 형식 오류, 상대 경로를 거부합니다.
  2. 경로 개수(5개 초과)를 검사합니다.
  3. 위 표의 조합을 판단합니다. 두 선택자를 함께 지정하면 여기서 거부합니다.
  4. `num_last_images_to_include`만 있으면 1~5 범위를 검사합니다.
- **경로 파일**: 각 파일을 읽어 참조 이미지로 씁니다. Codex와 같은 규칙입니다.
  - 절대 경로만 받고, `~`로 시작하면 홈 디렉터리로 확장합니다. 상대 경로는 인자 해석 단계에서 거부합니다.
  - 형식은 확장자가 아니라 파일 내용으로 판별합니다. 모든 참조 이미지는 디코딩할 수 있는지 확인합니다.
  - png, jpeg, webp는 원본 바이트를 그대로 보냅니다. 그 밖의 형식(GIF 등)은 PNG로 바꿔 보냅니다.
  - 크기 제한은 두지 않습니다.
- **최근 대화 이미지**: Codex `recent_images()`와 같은 순서 규칙을 씁니다.
  1. 모델이 실제로 보는 문맥(현재 분기, 압축과 문맥 편집 반영)의 메시지를 최신순으로 훑습니다.
  2. 이미지를 담을 수 있는 메시지는 모두 대상입니다. 사용자 메시지, 확장이 넣은 사용자 정의 메시지(custom), 도구 결과 메시지가 여기에 해당합니다. 앞선 `image_gen` 결과도 도구 결과이므로 대상이 됩니다. Codex도 역할과 상관없이 모든 메시지와 도구 결과를 훑습니다.
  3. 한 항목 안의 이미지는 뒤에서부터 셉니다.
  4. 정확히 N장을 모으면 멈추고, 시간순으로 되돌려 보냅니다.
  5. N장을 다 모으지 못하면 거부합니다.

Rationale:

- 조합 규칙과 이미지 수집 순서는 Codex를 그대로 따릅니다. 두 선택자를 함께 쓰지 못하게 해서 어떤 이미지가 대상인지 모호해지지 않게 합니다.
- 참조 이미지 처리는 Codex의 원본 모드 처리(크기 조정 없음)와 같습니다. PNG 변환은 Pi가 공개 API로 제공하는 이미지 변환 기능을 써서, 새 의존성 없이 TypeScript만으로 처리합니다([9.11](#911-codex-동일성-원칙)).
- 대화 이미지는 모델이 실제로 본 문맥에서 골라야 "최근 N장"이 모델의 인식과 일치합니다.
- Codex도 밝히고 있듯, 경로가 없는 대화 이미지는 고정된 참조가 없어 의도하지 않은 최신 이미지가 섞일 수 있습니다. 이 한계는 [13](#13-risks--open-questions)에 기록합니다.

### 9.5 요청 값 정책

Decision:

- `model: "gpt-image-2"`
- `quality: "auto"`, `size: "auto"`
- `background`: `transparent_background`가 참이면 `"transparent"`, 아니면 `"opaque"`
- `n`은 보내지 않습니다.
- 생성과 편집 모두 JSON으로 보냅니다. 편집 본문은 Codex `ImageEditRequest`와 같이 `images: [{ image_url: "data:<MIME>;base64,<바이트>" }]` 뒤에 고정값을 두며, 이미지 순서는 참조 경로의 인자 순서 또는 최근 이미지의 시간순을 유지합니다([9.4](#94-요청-라우팅-정책)).

Rationale:

- 요청 경로가 Codex와 같은 ChatGPT Images 경로이므로 본문도 Codex 형식을 따릅니다. 도구의 인자·고정값·참조 이미지·결과·저장 계약은 그대로입니다. 실제 편집 수용은 호출하지 않아 mock 검증까지만 확인했습니다.

**Superseded decision (2026-10-05).** `openai` 공개 Images API에 맞춘 multipart 편집 전송(`09` 인계)은 인증 경로 변경과 함께 대체했습니다([Revision History](#revision-history)).

### 9.6 오류 문구 정책

Decision:

- 다음 오류는 Codex 문구를 그대로 씁니다.
  - 인자 해석 오류: Codex 인자 해석기(serde)의 문구 형식을 씁니다. 예: `` unknown field `<name>`, expected one of `prompt`, `transparent_background`, `referenced_image_paths`, `num_last_images_to_include` ``, `` missing field `prompt` ``, `AbsolutePathBuf deserialized without a base path`
  - `` `referenced_image_paths` must contain at most 5 paths ``
  - `` `num_last_images_to_include` must be between 1 and 5 ``
  - `` provide only one of `referenced_image_paths` or `num_last_images_to_include` ``
  - `requested the last <N> conversation images, but only <M> were available`
  - `` unable to read referenced image at `<path>`: <error> ``
  - `` unable to process referenced image at `<path>`: <error> ``
  - `image generation returned no image data`
- 요청 실패는 Codex와 같이 `image generation failed: ` 뒤에 오류 내용을 붙입니다.
  - HTTP 오류: `http <상태 코드> <표준 이유 문구>: Some("<응답 본문>")`. UTF-8 본문이 빈 문자열이면 `Some("")`입니다. 본문을 문자열로 얻을 수 없을 때는 `None`입니다. 예: `image generation failed: http 401 Unauthorized: Some("{...}")`
  - 재시도 후에도 실패: `timeout`, `` connection failed: <오류> ``, `` network error: <오류> ``, `retry limit reached`
  - 응답 해석 실패: `` stream error: failed to decode image generation response: <오류> ``(편집은 `image edit response`)
- 오류 내용 중 Codex 자체 라이브러리(serde, 통신 라이브러리)가 만드는 세부 문구는 같은 형식으로 재현하되, 바이트 단위로 같지는 않습니다([9.11](#911-codex-동일성-원칙)).

Rationale:

- 같은 문구를 쓰면 모델이 Codex에서와 같은 방식으로 오류에서 회복합니다.
- HTTP 상태와 원인을 함께 주면 모델이 인증 문제인지 요청 문제인지 사용자에게 구분해 전할 수 있습니다.

### 9.7 저장 정책

Decision:

- 파일 이름은 `<sessionId>/<호출 ID>.png` 구조입니다.
- 두 ID 모두 `[A-Za-z0-9_-]` 밖의 문자를 `_`로 바꾸고, 결과가 비면 `generated_image`를 씁니다.
- 상위 폴더는 필요하면 만듭니다. 같은 경로에 파일이 있으면 Codex 저장 루트 경로와 같이 덮어씁니다.
- 저장 위치는 Codex와 같은 구조입니다. Codex app-server는 Codex 홈(`~/.codex`)을 저장 루트로 써서 `~/.codex/generated_images/<스레드 ID>/<호출 ID>.png`에 저장합니다. 이 기능은 Pi에서 Codex 홈에 해당하는 Pi 에이전트 디렉터리(기본 `~/.pi/agent`)를 루트로 써서 `<agentDir>/generated_images/<sessionId>/<호출 ID>.png`에 저장합니다. 작업 디렉터리에는 파일을 만들지 않습니다.
- 저장 실패는 도구 결과를 실패로 바꾸지 않습니다.

Rationale:

- 사용자가 저장 위치를 Codex와 동일하게 하기로 정했습니다.
- 이름 규칙, 덮어쓰기, 저장 실패를 결과 실패로 보지 않는 처리는 Codex 저장 루트 경로와 같습니다. Codex의 작업 폴더 대체 경로(크기 제한, 심볼릭 링크·기존 파일 거부)는 저장 루트가 없을 때만 쓰이는데, 이 기능은 항상 저장 루트가 있으므로 해당하지 않습니다.

### 9.8 경로 안내 정책

Decision:

- 저장에 성공하면 Codex `image_generation_output_hint()` 문구에 실제 폴더와 파일 경로를 넣어 모델에게 줍니다.

  ```text
  Generated images are saved to <dir> as <path> by default.
  If you need to use a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.
  The generated image is already displayed to the user. There is no need to render it in the final response as a Markdown image or file link.
  ```

- 문구가 1024바이트를 넘으면 안내를 뺍니다.

Rationale:

- 모델이 원본을 옮기거나 지우지 않게 하고, 이미 표시된 이미지를 답변에 다시 붙이지 않게 합니다. 문구와 길이 제한은 Codex와 같습니다.
- Pi TUI는 이미지 프로토콜을 지원하는 터미널(kitty, iTerm2, Warp 등)에서만 그림을 그리고, `terminal.showImages` 설정으로 끌 수도 있습니다. 그런 환경에서는 "already displayed" 문장이 사실과 다릅니다. 그래도 동작을 Codex와 맞추는 것을 우선해, 사용자가 문구를 원문 그대로 두기로 정했습니다.

### 9.9 자격 증명 미설정 시 노출 정책

Decision:

- Pi의 `openai-codex` 인증이 설정되지 않았으면 `image_gen`을 모델에 노출하지 않습니다. 채팅 공급자가 무엇이든 같은 기준입니다.
- 사용 가능 여부는 세션이 시작될 때와 사용자가 프롬프트를 보낼 때마다 다시 판단합니다. 그래서 세션 중 `/login`을 마치면 다음 프롬프트부터 도구가 보이고, 자격 증명이 사라지면 다음 프롬프트부터 보이지 않습니다.
  - 한 프롬프트 안의 이어지는 모델 호출, 후속·조정(follow-up·steer) 메시지에서는 다시 판단하지 않습니다. 그 사이에 자격 증명이 사라지는 경우는 호출 시점 확인이 처리합니다.
  - 노출 판단은 네트워크 없이 `openai-codex` 인증의 설정 여부만 확인합니다. 토큰의 실제 사용 가능 여부와 갱신 실패는 호출 시점에 처리합니다([9.1](#91-공급자와-인증-정책)).
- 이 기능은 `image_gen`의 노출 여부만 바꿉니다. 다른 도구의 활성 상태는 건드리지 않습니다.
- 사용자가 끈 `image_gen`은 자격 증명이 있어도 다시 켜지 않습니다. 끄는 방법에 따라 보장 방식이 다릅니다.
  - **실행 옵션으로 끈 경우**: `-t`/`--tools`에서 빼거나, `-xt`/`--exclude-tools`로 제외하거나, `-nt`/`--no-tools`를 쓴 경우입니다. Pi가 도구를 등록 목록에서 아예 빼므로 이 기능은 다시 켤 수 없습니다. Pi가 보장합니다.
  - **세션 중에 다른 확장이나 명령으로 끈 경우**: 이 기능은 자격 증명이 없어 자신이 숨긴 경우에만 도구를 다시 켭니다. 자신이 숨겼다는 사실은 세션 분기에 함께 기록해, `/tree`로 분기를 옮겨 Pi가 그 분기의 도구 상태를 되살려도 자신이 숨긴 경우와 사용자가 끈 경우를 구분합니다.
  - **설정 `defaultTools`**: Pi 0.99.1에서는 이 설정으로 확장 도구를 끌 수 없습니다(`-image_gen`을 적어도 효과가 없음). 설정으로 계속 끄는 방법은 이 기능이 제공하지 않습니다.
- 세션을 재개하거나 `/reload`하면 Pi가 확장 도구를 모두 다시 켭니다. 세션 중에 끈 상태가 이때 풀리는 것은 Pi 자체 동작이며 이 기능이 바꾸지 않습니다. 이 기능은 그 뒤 구독 인증을 새로 판단합니다. 도구가 활성 상태로 복원됐으면 과거의 “이 기능이 숨김” 소유 기록을 해제해, 이후 사용자가 끈 상태를 자동으로 되돌리지 않습니다.
- `/tree` 이동 후에는 현재 분기의 기록을 기준으로 판단하고, 다른 분기에서 남은 메모리 상태를 가져오지 않습니다.
- 이 기능이 숨겨 둔 동안 사용자가 같은 도구를 끄려고 해도 이미 꺼진 상태라 구분할 수 없습니다. 이 경우 자격 증명이 돌아오면 도구가 다시 켜집니다. 사용자가 계속 끄려면 그 뒤에 다시 꺼야 합니다.
- 도구가 노출된 턴 안에서 호출 시점에 자격 증명이 없으면 [9.1](#91-공급자와-인증-정책)의 안내 오류로 거부합니다.

Rationale:

- 사용자가 자격 증명이 없을 때는 사용할 수 없게 하기로 정했습니다. Codex도 사용할 수 없는 환경에서는 도구를 모델에 보여 주지 않습니다.
- 프롬프트마다 다시 판단하는 것은 Pi에서 세션 중 로그인 상태가 바뀔 수 있기 때문입니다. 프롬프트를 처리하기 전에 활성 도구를 바꾸면 Pi 0.99.1에서는 그 프롬프트의 요청에 바로 반영됩니다.
- Codex는 현재 모델이 이미지 입력을 받지 못하면 도구를 숨기지만, 이 기능은 그 조건으로 숨기지 않습니다. 그런 모델에서도 결과 파일과 경로 안내는 그대로 쓸 수 있기 때문입니다. 도구를 숨기는 처리는 첫 릴리스 범위 밖입니다([12](#12-scope)).
- 노출 판단 시점과 호출 시점 사이에 자격 증명이 사라질 수 있으므로, 호출 시점의 확인도 함께 둡니다.
- 사용자가 끈 도구는 다시 켜지지 않아야 한다고 사용자가 정했습니다. 사용자의 도구 선택이 확장의 자동 판단보다 우선합니다.

### 9.10 이미지 생성 스킬 정책

Decision:

- Codex 번들 스킬 `imagegen`을 Pi에 맞게 고친 사본을 이 기능과 함께 배포하고 Pi 스킬로 등록합니다. Codex 설치 위치(`~/.codex/skills/.system/imagegen`)를 직접 참조하지 않습니다.
- 스킬 이름 `imagegen`과 설명의 판단 기준(언제 쓰고 언제 쓰지 않는지)은 유지합니다. 설명 안의 "Codex"와 "built-in" 표현만 Pi에 맞게 바꿉니다.
- 다음은 Pi에 맞게 바꿉니다.
  - `view_image`를 Pi의 `read` 도구로 바꿉니다.
  - "Built-in edit semantics" 문단과 Workflow 7단계를 실제 도구에 맞게 고칩니다. 원문은 "로컬 파일을 먼저 `view_image`로 대화에 올린 뒤 편집"하고 "임의의 파일 경로 편집을 약속하지 말라"고 하지만, 이 기능은 `referenced_image_paths`로 로컬 파일을 바로 편집합니다([9.4](#94-요청-라우팅-정책)). 도구 설명의 두 선택자 규칙과 같은 내용이 되게 합니다.
  - `$CODEX_HOME/generated_images/...` 저장 위치를 이 기능의 저장 위치로 바꿉니다([9.7](#97-저장-정책)).
  - 인증 안내는 [9.1](#91-공급자와-인증-정책)에 맞춥니다. Pi에 이미 저장된 `openai-codex` 구독 로그인을 재사용하며, 없을 때만 `/login openai-codex`를 안내합니다. API 키 설정이나 채팅 공급자 변경을 요구하지 않습니다.
  - Codex UI 메타데이터(`agents/openai.yaml`, `assets/`)는 포함하지 않습니다.
- CLI 대체 모드는 파일과 문장 모두에서 지웁니다.
  - 파일: `scripts/image_gen.py`, `scripts/remove_chroma_key.py`, `references/cli.md`, `references/image-api.md`, `references/codex-network.md`
  - `SKILL.md`: "Top-level modes and rules"의 CLI 모드와 `gpt-image-1.5` 전환 규칙, Execution strategy의 CLI `generate-batch`와 `n` 설명(`n`은 이 도구의 인자가 아님), Workflow의 CLI 관련 단계(1, 4, 17, 18단계의 CLI 부분), "gpt-image-2 guidance for CLI fallback" 절, "Fallback CLI mode only" 절
  - `references/prompting.md`와 `references/sample-prompts.md`: CLI 전용 문장과 지워지는 참조 파일을 가리키는 연결, "CLI `gpt-image-2` does not support `background=transparent`; ask before using `gpt-image-1.5`" 같은 CLI 기준 모델 안내
  - 원문에서 CLI 대체 안내가 있던 자리("built-in 도구가 실패하거나 없으면")에는 "`image_gen` 도구를 쓸 수 없으면 사용자에게 알리고, 구독 로그인이 없는 경우 `/login openai-codex`를 안내하라"는 지침을 둡니다. 스킬은 도구와 함께 숨겨지므로, 이 지침은 사용자가 `/skill:imagegen`으로 직접 부른 경우에 쓰입니다.
- 다음은 CLI 관련 문장을 빼고 유지합니다.
  - "When to use" / "When not to use" 판단 기준
  - 생성·편집 의도 판단과 프롬프트 정리 지침(`references/prompting.md`, `references/sample-prompts.md`)
  - 프로젝트에서 쓸 이미지는 작업 폴더로 복사하고, 기존 파일은 덮어쓰지 않는다는 규칙
- 스킬은 `image_gen`이 모델에 노출될 때만 스킬 목록에 보입니다. 도구가 숨겨지면 이유(자격 증명 없음, 사용자가 끔)와 상관없이 스킬도 목록에서 빠집니다. 판단 시점은 도구 노출과 같습니다([9.9](#99-자격-증명-미설정-시-노출-정책)).
- 라이선스
  - 원문의 Apache-2.0 라이선스 파일을 사본과 함께 둡니다.
  - 고친 파일에는 고쳤다는 고지를 달고, Codex 저장소의 `NOTICE` 내용("OpenAI Codex / Copyright 2025 OpenAI")을 배포물에 포함합니다. Codex 도구 설명에서 가져온 문구([9.3](#93-도구-설명-정책))도 같은 고지 대상입니다.

Rationale:

- 사용자가 `image_gen`이 이 스킬을 쓰게 하기로 정했고, 사본을 Pi에 맞게 고치는 방식과 CLI 대체 모드 제거에 동의했습니다.
- Pi 스킬 탐색은 이름이 `.`으로 시작하는 폴더를 건너뛰므로, Codex 설치 위치에 있는 스킬은 Pi에 불려 오지 않습니다. 직접 참조하면 Codex가 설치되지 않은 환경에서도 동작하지 않습니다.
- 원문은 Codex 전용 도구, 경로, 인증, 샌드박스를 전제합니다. 그대로 쓰면 모델이 실제 도구와 맞지 않는 지시를 받습니다.
- CLI 대체 모드는 Python, `uv`, `OPENAI_API_KEY`, Codex 샌드박스 설정이 필요합니다. 이 기능과 별개의 실행 경로이고, 품질·크기 직접 지정이 필요해지면 도구 인자로 다루는 것이 낫습니다([16](#16-future-extensions)). 지우는 참조 파일을 가리키는 문장이 남으면 모델이 없는 파일을 찾으므로 함께 지웁니다.
- 스킬의 "When not to use"는 SVG나 코드로 만드는 것이 나은 아이콘·다이어그램에 이 도구를 쓰지 않도록 안내합니다. Codex는 이 스킬을 기본으로 켜 두므로, 도구 설명의 "Always use this tool for image editing" 지침과 이 안내가 함께 모델에 주어집니다. 스킬 본문은 작업이 설명과 맞을 때만 읽히므로, 항상 견제가 작동한다고 단정할 수는 없습니다(추론).
- 사용자가 도구가 숨겨지면 스킬도 숨기기로 정했습니다. 도구를 쓸 수 없는데 스킬만 보이면 모델이 없는 도구를 찾거나, 사용자가 일부러 끈 경우에도 `/login`을 안내하게 됩니다. Pi는 프롬프트를 처리하기 전에 스킬 목록을 바꾸는 것을 허용하므로 도구와 같은 시점에 함께 숨길 수 있습니다. Pi는 `read`나 `bash` 도구가 켜져 있을 때만 스킬 목록을 보여 줍니다.
- 스킬 이름이 겹치면 Pi는 먼저 찾은 스킬만 남기고 경고합니다. Codex 설치 위치의 같은 이름 스킬은 숨김 폴더에 있어 Pi가 불러 오지 않으므로 충돌하지 않습니다.
- Apache-2.0은 고친 파일의 변경 고지(4(b))와 `NOTICE` 내용 유지(4(d))를 요구합니다.

### 9.11 Codex 동일성 원칙

Decision:

- 도구 동작은 Codex `image_gen` 구현과 정확히 일치시킵니다. 대상은 모델이 보는 스키마, 인자 검사 순서와 문구, 참조 이미지 처리, 요청 값, 재시도, 응답 처리, 저장, 결과 형식, 오류 문구입니다. 이 문서의 다른 정책과 Codex 동작이 다르면 Codex 동작을 따릅니다. 단, 아래 목록의 차이와 사용자가 정한 결정은 예외입니다.
- Pi 패키지는 TypeScript로만 구성합니다.
  - Rust, Python, 네이티브 바이너리, 외부 명령 실행을 쓰지 않습니다.
  - 런타임 의존성은 Pi가 제공하는 패키지(`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`)와 Node 내장 기능만 씁니다.
  - 이미지 디코딩·PNG 변환은 Pi 공개 API의 이미지 변환 기능을 씁니다.
  - 스킬 사본에는 Markdown 문서와 라이선스 파일만 둡니다([9.10](#910-이미지-생성-스킬-정책)).
- 재시도는 Codex 공급자 기본값과 같습니다.
  - 최대 5번 시도합니다(처음 1번 + 재시도 4번).
  - 5xx 응답과 타임아웃·연결·네트워크 오류만 재시도합니다. 429와 다른 4xx는 재시도하지 않습니다.
  - 대기 시간은 200ms에서 시작해 재시도마다 두 배로 늘리고 ±10% 무작위 흔들림을 줍니다. 응답에 `Retry-After`가 있으면 그 값을 따릅니다.
  - 사용자가 중단하면 재시도도 멈춥니다.
- Codex와 달라질 수밖에 없는 부분은 다음뿐입니다.
  - **인증 출처와 헤더 값**: 토큰은 Codex 자체 로그인 대신 Pi `openai-codex` 로그인에서 얻고, `originator`는 Pi의 값(`pi`), 턴 ID는 도구 호출 ID를 씁니다. 주소·본문 형식은 Codex와 같고 현재 채팅 설정은 그대로입니다([9.1](#91-공급자와-인증-정책), [9.5](#95-요청-값-정책)).
  - **Codex 백엔드 전용 이벤트**: Pi 도구 결과에는 Codex의 별도 사용량 한도 이벤트와 imagegen 분석 이벤트 구조가 없으므로, `limit_id == "image_gen"` 전용 이벤트·무료 요금제 사전 차단·요청 ID 분석은 구현하지 않습니다. 백엔드가 거부한 요청은 HTTP 오류로 전달합니다.
  - **비밀값 보호**: 서버가 토큰이나 계정 ID를 오류에 되돌려 보낸 경우에는 그 값만 제거합니다. 나머지 오류 형식은 유지합니다.
  - **사용자 결정으로 달라지는 부분**: 도구 이름과 설명 변경([9.3](#93-도구-설명-정책)), 저장 루트([9.7](#97-저장-정책)), 자격 증명에 따른 노출([9.9](#99-자격-증명-미설정-시-노출-정책)), 스킬 수정([9.10](#910-이미지-생성-스킬-정책))
  - **런타임 차이**:
    - Codex는 인자를 원본 JSON 문자열에서 해석해 오류에 `at line <n> column <m>` 위치를 붙입니다. Pi는 해석된 인자를 넘겨주므로 이 위치는 재현하지 않습니다.
    - 응답 해석 오류와 통신 오류의 세부 문구는 Rust 라이브러리가 만들므로 형식만 맞춥니다.
    - PNG로 바꿀 때 Codex는 색 프로필(ICC)과 EXIF를 보존하지만, Pi 이미지 변환은 EXIF 방향을 적용한 뒤 메타데이터를 보존하지 않습니다. png·jpeg·webp는 원본 바이트를 보내므로 영향이 없습니다.
    - 디코딩할 수 있는 이미지 형식의 범위가 Codex와 Pi 이미지 변환 기능 사이에 완전히 같다는 보장은 없습니다.
    - Pi 도구 결과의 이미지에는 Codex의 이미지 세부도(`detail`) 값이 없습니다.

Rationale:

- 사용자가 Codex에서 구현된 것과 정확하게 일치하게 하고, Pi 패키지는 TypeScript로만 구성하기로 정했습니다.
- Pi가 공개 API로 이미지 변환 기능을 제공하므로, 새 의존성이나 네이티브 코드 없이 Codex의 참조 이미지 처리를 재현할 수 있습니다.
- 재현할 수 없는 차이를 한 곳에 모아 두어야 구현자가 그 밖의 차이를 버그로 판단할 수 있습니다.

---

## 10. Alternatives Considered

### Alternative: Pi `openai` 토큰으로 이미지 요청 — 서버 거부로 제외

Description:

- 채팅에 쓰는 Pi `openai`(Sign in with ChatGPT) 토큰으로 공개 Images API, ChatGPT Images 경로, 또는 Responses의 `image_generation` 도구를 호출합니다.

Why not chosen:

- 세 경로 모두 실제 호출에서 거부됐습니다(401 `hardened_oauth_rule_missing`, 401 `no_matching_rule`, 400 `subscription_sharing_unsupported_capability`). Responses 거부 메시지는 구독 공유가 `web_search`와 개발자 정의 도구만 지원한다고 밝힙니다. 한동안 이 방식을 채택했던 이력은 [Revision History](#revision-history)에 있습니다.

### Alternative: `openai-codex` 로그인과 ChatGPT Images 경로 — 현재 채택

Description:

- Codex와 같이 `chatgpt.com/backend-api/codex/images/*`에 계정·턴 헤더와 JSON 본문으로 요청합니다. 채팅은 현재 공급자로 유지합니다.

Decision history:

- 최초 제외 → PoC 성공으로 중간 채택(`07`·`08`) → `openai` 전용 요구로 제외(`09`) → `openai` 거부 확인 후 사용자 결정으로 다시 채택했습니다(`11`).

### Alternative: pi-ai `generateImages()` 레지스트리에 OpenAI 이미지 공급자 등록

Description:

- OpenAI 이미지 API 공급자와 모델을 pi-ai 레지스트리에 등록한 뒤 `generateImages()`로 호출합니다.

Why not chosen:

- pi-ai 0.99.1에는 OpenAI 이미지 모델 정의가 없습니다. 공급자와 모델을 새로 정의하려면 이 기능 범위를 넘는 작업이 필요합니다. 나중에 확장할 방향으로 [16](#16-future-extensions)에 남깁니다.

### Alternative: 공식 `openai` SDK를 런타임 의존성으로 추가

Description:

- `openai` 패키지의 `images.generate()`와 `images.edit()`를 직접 씁니다.

Why not chosen:

- Node 22에 내장된 `fetch`와 `Buffer`만으로 두 JSON 요청을 만들 수 있고, SDK는 ChatGPT Images 경로의 계정·턴 헤더와 본문 형식을 기본으로 다루지 않습니다. 사용자 작업 지침(전역 AGENTS.md)은 외부 의존성을 꼭 필요할 때만 추가하도록 요구합니다.

---

## 11. Cross-cutting Concerns

### 11.1 Security

- Pi가 반환한 인증 값과 추가 인증 헤더는 요청에만 씁니다. 도구 결과 내용, 부가 정보, 오류 문구, 로그에 넣지 않습니다. 서버 오류에 반사된 비밀값도 제거합니다.
- 경로 파일은 모델이 지정한 경로를 읽습니다. 개수·형식·크기 제한은 [9.4](#94-요청-라우팅-정책)를 따릅니다.
- 저장은 Codex와 같이 에이전트 디렉터리 아래 정해진 경로에만 쓰고, 같은 경로에 파일이 있으면 덮어씁니다([9.7](#97-저장-정책)). 파일 이름은 세션 ID와 호출 ID에서 허용 문자만 남기므로 다른 폴더를 가리킬 수 없습니다.
- 외부 네트워크를 사용하고 파일을 쓰는 도구로 표시합니다(`readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: true`). 그래서 함께 켜진 권한·검토 확장이 이를 근거로 판단할 수 있습니다.

### 11.2 Privacy

- 프롬프트와 참조 이미지는 OpenAI로 전송됩니다. 여기에는 사용자의 로컬 파일과 대화 속 이미지가 포함될 수 있습니다.
- 결과 이미지는 세션 기록과 저장 파일에 남습니다([8.1](#81-behavior)).
- 별도의 OpenAI `user` 필드는 보내지 않습니다. 패키지가 계정 ID를 추출하지 않으며 Pi가 제공하는 인증 헤더는 결과·기록에 남기지 않습니다([9.1](#91-공급자와-인증-정책)).

### 11.3 Permissions

- 이 기능은 새 권한 체계를 만들지 않습니다. 도구 노출은 Pi 이미지용 구독 인증의 설정 여부로 정하며, 실제 호출 권한은 백엔드가 판단합니다([9.9](#99-자격-증명-미설정-시-노출-정책)).
- 요금제나 사용량 한도는 OpenAI가 판단하고, 그 오류는 HTTP 실패로 전달됩니다. Codex의 무료 요금제 차단과 `image_gen` 사용량 한도 해석은 재현하지 않습니다.

### 11.4 Observability

- 성공 결과의 부가 정보에 저장 경로, 요청 종류(생성·편집), 배경 값을 남깁니다. base64 데이터는 남기지 않습니다.
- 저장 실패는 결과를 실패로 바꾸지 않으므로, 경로 안내가 없고 부가 정보에 `savedPath`가 없는 것으로 구분됩니다.
- Codex의 imagegen 요청 ID 수집과 분석 이벤트는 다루지 않습니다.

### 11.5 Accessibility

- Not applicable: 이 기능은 새 UI 요소를 만들지 않고 Pi 기본 도구 결과 표시를 그대로 씁니다. 생성 이미지의 대체 텍스트는 모델 답변에 맡깁니다.

### 11.6 Internationalization

- 모델이 보는 도구 설명, 경로 안내, 오류 문구는 Codex와 같게 영어로 둡니다. 모델 동작을 Codex와 맞추기 위해서입니다.
- 프롬프트 언어는 제한하지 않고 OpenAI에 그대로 전달합니다.

---

## 12. Scope

### In Scope for 첫 릴리스

- 모델 호출용 도구 `image_gen` 하나
- 프롬프트만으로 생성
- 로컬 경로 기반 편집과 최근 대화 이미지 기반 편집
- 투명 배경 요청
- 채팅 공급자를 유지하며 기존 Pi ChatGPT 구독 인증 재사용
- PNG 저장과 경로 안내
- 진행 표시, 취소, [8.3](#83-failure-handling)의 실패 처리
- 자격 증명 유무에 따른 도구 노출 전환(사용자가 끈 도구는 다시 켜지 않음)
- Pi에 맞게 고친 이미지 생성 스킬과, 도구와 함께 숨기는 처리([9.10](#910-이미지-생성-스킬-정책))
- Codex와 같은 재시도·오류 문구·참조 이미지 처리([9.11](#911-codex-동일성-원칙))

### Out of Scope for 첫 릴리스

- 품질·크기·모델 설정, 여러 장 생성, 부분 이미지 스트리밍, 마스크, `input_fidelity`
- 도구 호출·결과의 전용 TUI 렌더링
- 현재 모델이 이미지를 못 받을 때 도구를 숨기는 처리
- Codex 사용량 한도 해석, 무료 요금제 차단, 요청 ID 분석
- pi-ai 이미지 레지스트리 등록
- 사용 안내 문서(README 등)
- Codex 스킬의 CLI 대체 모드

---

## 13. Risks & Open Questions

### Risks

- **`openai-codex` 의존**: Pi 1.0.2는 이 공급자를 `OpenAI Codex (legacy)`로 표시합니다. Pi가 이 공급자나 로그인을 없애면 이미지 인증 경로도 다시 정해야 합니다. ChatGPT Images 경로는 공개 문서화된 API가 아니어서 서버 계약이 예고 없이 바뀔 수 있습니다.
- **실제 편집**: 로컬 mock에서 JSON `images` 데이터 URL의 MIME·바이트·순서를 확인했지만, 실제 편집 호출은 하지 않았습니다.
- **투명 배경**: 도구는 Codex와 같은 `background: transparent` 값을 전달합니다. 실제 결과의 투명도는 확인하지 않았습니다.
- **토큰 갱신**: Pi 0.99.1 소스에서는 자격 증명을 얻을 때 만료가 가까운 로그인 토큰을 갱신하고, 실패하면 오류를 냅니다. 또 저장된 로그인이 있으면 자격 증명이 있다고 판단하므로, 도구가 노출됐는데 호출 시점에 거부될 수 있습니다([8.3](#83-failure-handling)). 실제 호출로는 확인하지 않았습니다.
- **요청 대기 시간**: Node 내장 `fetch`의 기본 대기 시간이 모델의 생성 시간보다 짧을 수 있습니다. 저장소에서는 확인하지 못했습니다.
- **빈 이미지 응답**: Codex와 같이 `b64_json`이 빈 문자열이면 성공으로 처리하므로, 빈 저장 파일과 빈 이미지 결과가 생길 수 있습니다.
- **크기 제한 없음**: Codex와 같이 참조 이미지 크기를 미리 제한하지 않으므로, 사용하는 엔드포인트가 거부하는 크기의 파일은 HTTP 실패로 끝납니다. 이번 변경에서 서비스의 실제 크기 제한을 확인하지 않았습니다.
- **Pi 이미지 변환 기능의 가용성**: Pi의 이미지 변환 기능을 쓸 수 없는 환경에서는 PNG 변환이나 디코딩 확인이 실패해 `unable to process referenced image` 오류가 납니다. 로컬 검증에서는 png·jpeg·webp 디코딩과 gif·bmp PNG 변환이 성공했지만 다른 환경의 가용성은 확인하지 않았습니다.
- **Pi codemode에서의 호출**: Pi `codemode` 스크립트에서 다른 도구를 부르면 결과가 텍스트로만 돌아옵니다. codemode에서 `image_gen`을 부르면 이미지가 모델에 전달되지 않고 경로 안내만 남을 수 있습니다. 동작을 확인하지 않았습니다.
- **대화 이미지 선택**: 경로가 없는 이미지는 고정 참조가 없어, 대상보다 새로운 관련 없는 이미지가 섞일 수 있습니다(Codex와 같은 한계).
- **세션 파일 크기**: 결과 이미지가 base64로 세션에 남아 생성할 때마다 세션 파일이 커집니다.
- **사용량**: 실제 호출은 ChatGPT 구독의 사용량·한도 정책을 따릅니다. 실제 차감량은 확인하지 않았습니다. 검증 과정의 추가 실제 생성·편집은 승인 범위 안에서만 실행합니다.
- **모델별 호출 성향**: Codex는 주로 GPT 계열 Codex 모델로 쓰이지만 Pi에서는 다른 모델을 쓸 수 있습니다. 도구 설명이 같아도 요청 없이 호출하거나 지나치게 아끼는 정도가 모델마다 다를 수 있습니다. 실제 사용에서 관찰해야 합니다.
- **스킬 사본 동기화**: 스킬 사본은 Codex 원본이 바뀌어도 자동으로 따라가지 않습니다.

### Open Questions

- 이미지 인증은 `openai-codex`로 확정됐습니다. 남은 미확인 사항은 위 위험 목록과 같습니다.

---

## 14. Platform Design

### 14.1 Common Design

- 런타임은 Node 22.19 이상입니다(저장소 `engines` 기준). 내장 `fetch`, `Headers`, `Buffer`를 써서 계정 ID 클레임 읽기, 생성·편집 JSON을 처리합니다.
- 패키지는 TypeScript로만 구성하므로 운영체제별 네이티브 바이너리가 없습니다([9.11](#911-codex-동일성-원칙)).
- 타입·빌드 기준은 저장소에 설치된 Pi 0.99.1입니다. 기존 인증 조회와 실제 구독 생성은 로컬 Pi 1.0.2에서도 확인했습니다. 다른 버전을 모두 검증했다는 뜻은 아닙니다.
- 경로 조합과 폴더 생성은 운영체제의 경로 규칙을 따릅니다.

### 14.2 macOS / Linux

- 별도 차이는 없습니다.

### 14.3 Windows

- 저장 파일 이름의 문자 치환([9.7](#97-저장-정책)) 덕분에 Windows에서 금지된 문자가 파일 이름에 들어가지 않습니다. 실제 Windows 동작은 확인하지 않았습니다.

---

## 15. Result Semantics

| State | Meaning | User-visible? |
| ----- | ------- | ------------- |
| 진행 중 | 요청을 보냈고 응답을 기다립니다. | Yes |
| 성공 | 이미지가 표시되고 저장됐습니다. 모델은 이미지와 경로 안내를 받습니다. | Yes |
| 부분 성공 | 이미지는 표시됐지만 저장에 실패했습니다. 경로 안내가 없습니다. | Yes |
| 사용 불가 | 자격 증명이 없어 도구가 모델에 노출되지 않습니다. | No (도구 호출이 일어나지 않음) |
| 거부 | 인자, 참조 이미지, 자격 증명 문제로 요청을 보내지 않았습니다. | Yes |
| 실패 | OpenAI 오류나 빈 응답으로 이미지를 받지 못했습니다. | Yes |
| 취소 | 사용자가 중단했습니다. 파일을 저장하지 않습니다. | Yes |

---

## 16. Future Extensions

- OpenAI 이미지 공급자를 pi-ai 레지스트리에 등록해 다른 Pi 기능에서도 이미지 생성을 쓰게 하는 방향
- 품질·크기 설정과 사용자 기본값
- 생성 결과용 전용 TUI 렌더링
- 다른 공급자(OpenRouter, Google)의 이미지 모델 지원

---

## Appendix

### 근거 자료

> 이 부록은 설계 근거를 찾아가기 위한 참조입니다. 작업 지시가 아닙니다. 아래 위치는 2026-10-05에 확인한 상태이며 바뀔 수 있습니다. `tmp/codex-main`은 `.gitignore` 대상이라 다른 환경에는 없을 수 있습니다.

| 설계 항목 | 근거 위치 |
| --- | --- |
| 인자, 라우팅, 요청 값, 결과 형식 | `tmp/codex-main/codex-rs/ext/image-generation/src/tool.rs`: `ImagegenArgs`, `request_for_call_args()`, `recent_images()`, `GeneratedImageOutput` |
| 도구 설명 원문 | `tmp/codex-main/codex-rs/ext/image-generation/imagegen_description.md` |
| 저장 이름 규칙, 경로 안내 문구 | `tmp/codex-main/codex-rs/ext/image-generation/src/artifact.rs` |
| 엔드포인트, 응답 구조 | `tmp/codex-main/codex-rs/codex-api/src/endpoint/images.rs`, `codex-api/src/images.rs` |
| Codex 노출 조건 | `tmp/codex-main/codex-rs/core/src/tools/spec_plan.rs`: `image_generation_available()` |
| 공개 API 필드, 모델 목록, 편집 제한 | `node_modules/openai/resources/images.d.ts`, `images.js` (openai 7.19.0) |
| `openai` 로그인 방식(이미지 미사용 근거) | `node_modules/@earendil-works/pi-ai/dist/providers/openai.js`, `dist/auth/oauth/openai-chatgpt.js`: `dynamic_agent_client`, `resource: https://api.openai.com/v1` |
| `openai-codex` 주소·계정 헤더·`originator` | `node_modules/@earendil-works/pi-ai/dist/providers/openai-codex.js`, `dist/auth/oauth/openai-codex.js`, `dist/api/openai-codex-responses.js`: `extractAccountId()`, `buildBaseCodexHeaders()` |
| 이미지 턴 헤더 | `tmp/codex-main/codex-rs/ext/image-generation/src/backend.rs`: `X_CODEX_IMAGE_TURN_ID_HEADER` |
| `openai` 거부 기록과 `openai-codex` 최종 실제 검증 | `docs/handoffs/image-gen/11-openai-codex-image-auth.json` |
| 이전 `openai` 전용 구현의 검증 범위(대체됨) | `docs/handoffs/image-gen/09-openai-provider.json` |
| Codex 인증별 주소 선택 | `tmp/codex-main/codex-rs/model-provider-info/src/lib.rs`: `to_api_provider()` |
| 실제 구독 생성 결과와 로컬 Pi 인증 경로 | `docs/handoffs/image-gen/07-subscription-live.json` |
| 정식 패키지 반영과 오프라인 검증 범위 | `docs/handoffs/image-gen/08-package-completion.json` |
| 비전 미지원 모델의 이미지 치환 | `node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js` |
| Codex 이미지 생성 스킬 원본, 라이선스 | `tmp/codex-main/codex-rs/skills/src/assets/samples/imagegen/`, `tmp/codex-main/NOTICE` |
| 참조 경로 해석(절대 경로, `~` 확장) | `tmp/codex-main/codex-rs/utils/absolute-path/src/lib.rs`: `AbsolutePathBuf` |
| 참조 이미지 처리(형식 판별, 원본 유지 형식, PNG 변환) | `tmp/codex-main/codex-rs/utils/image/src/lib.rs`: `load_for_prompt_bytes()`, `can_preserve_source_bytes()` |
| 모델에 보내는 스키마에서 빠지는 키워드 | `tmp/codex-main/codex-rs/tools/src/json_schema/types.rs`: `JsonSchema`(`maxItems`·`minimum`·`maximum`·`default` 필드 없음) |
| 재시도 정책 | `tmp/codex-main/codex-rs/model-provider-info/src/lib.rs`(`DEFAULT_REQUEST_MAX_RETRIES`, `ApiRetryConfig`), `codex-rs/codex-client/src/retry.rs`(`should_retry`, `backoff`, `run_with_retry`) |
| HTTP·통신 오류 문구 | `tmp/codex-main/codex-rs/http-client/src/error.rs`(`TransportError`), `codex-rs/codex-api/src/error.rs`(`ApiError`) |
| Pi 이미지 변환 공개 API | `node_modules/@earendil-works/pi-coding-agent/dist/index.d.ts`: `convertToPng` |

### Pi 0.99.1 확장 API 노트

- 도구 등록은 `pi.registerTool(ToolDefinition)`입니다. 주요 필드는 `name`, `label`, `description`, `promptSnippet`, `promptGuidelines`, TypeBox `parameters`, `annotations`, `execute(toolCallId, params, signal, onUpdate, ctx)`입니다. `Type`은 `@earendil-works/pi-ai`가 다시 내보냅니다.
- `execute()`는 `{ content: (TextContent | ImageContent)[], details, isError? }`를 돌려줍니다. 이미지 블록은 `{ type: "image", data, mimeType }` 형태입니다.
- 활성 도구 목록은 `pi.getActiveTools()`와 `pi.setActiveTools()`로 다루고, `session_start`와 `before_agent_start` 이벤트를 받을 수 있습니다. `before_agent_start` 처리 중에 `setActiveTools()`를 부르면 그 요청에 바로 반영됩니다. 핸들러가 끝난 뒤 실제 활성 목록으로 이번 요청의 도구 구성을 만들기 때문입니다(`agent-session.js`의 `emitBeforeAgentStart()` 직후 처리). `ctx.modelRegistry.getProviderAuthStatus("openai-codex")`는 `{ configured, source }`를 돌려줍니다.
- `ctx.modelRegistry.getProviderAuth("openai-codex")`는 `{ auth: { apiKey, headers, baseUrl }, env, source }`를 돌려주고(필요하면 Pi가 토큰을 갱신), `getProvider("openai-codex")`는 기준 주소 `https://chatgpt.com/backend-api`를 가진 공급자 정의를 돌려줍니다.
- `ctx.sessionManager.buildSessionProjection().messages`는 모델이 실제로 보는 문맥(현재 분기, 압축과 문맥 편집 반영)을 돌려줍니다. `buildContextEntries()`는 문맥 편집(`context_edit`)을 반영하지 않습니다. 메시지 역할에는 `user`, `assistant`, `toolResult`, `custom`, `system`, `bashExecution`, `branchSummary`, `compactionSummary` 등이 있고, 이미지는 `user`, `custom`, `toolResult` 메시지에 담길 수 있습니다.
- 인자는 `execute()` 전에 TypeBox 스키마로 검사되고, 실패하면 `Validation failed for tool "<name>": ...` 오류가 돌아갑니다(`pi-agent-core` `agent-loop.js`의 `validateToolArguments`).
- 시작·재개·`/reload` 때 Pi는 확장 도구를 모두 켭니다(`agent-session.js`, `includeAllExtensionTools: true`). 분기 기록에서 도구 상태를 되살리는 것은 `/tree` 이동뿐입니다(`_restoreToolsFromTranscript()`). `--tools`, `--exclude-tools`, `--no-tools`로 빠진 도구는 등록 목록에서 제거됩니다(`isAllowedTool`). 설정 `defaultTools`의 `-name`은 기본 도구 목록에서만 빼므로 확장 도구에는 효과가 없습니다(`settings-manager.js` `resolveDefaultTools()`).
- `before_agent_start` 처리 중에 `event.systemPromptOptions.skills`를 바꾸면 그 요청의 스킬 목록에 반영됩니다. 스킬 탐색은 이름이 `.`으로 시작하는 폴더를 건너뜁니다(`skills.js`). 패키지는 manifest의 `pi.skills`로 스킬을 등록할 수 있고, 확장은 `resources_discover`에서 `skillPaths`를 돌려줄 수도 있습니다.
- `getAgentDir()`는 `@earendil-works/pi-coding-agent`에서 내보냅니다.
- 로컬 확장은 `pi -e <path>`로 불러오고, `-ne`를 함께 쓰면 명시한 확장만 불러옵니다.

## Revision History

### 2026-10-05 — 기존 구독 인증과 이미지 요청 경로 정정

- 사용자는 기존 Pi 구독 인증으로 이미지 생성 1회를 확인하고, 그 경로를 정식 패키지에 반영하도록 승인했습니다. 채팅 공급자 선택을 이미지 인증 제한으로 해석했던 최초 정책을 대체합니다.
- [9.1](#91-공급자와-인증-정책)의 인증·주소·헤더, [9.5](#95-요청-값-정책)의 편집 JSON, [9.9](#99-자격-증명-미설정-시-노출-정책)의 구독 노출 판단, [9.10](#910-이미지-생성-스킬-정책)의 로그인 안내를 수정하고 관련 흐름·범위·위험·대안을 맞췄습니다. 도구 설명·스키마·저장·결과 안내는 유지합니다.
- 근거: Codex의 인증별 주소 선택과 이미지 클라이언트, Pi 0.99.1 타입·소스, 실제 로컬 Pi 1.0.2 인증 조회 및 구독 생성 성공(`07-subscription-live.json`), 정식 패키지 오프라인 결과(`08-package-completion.json`).
- 검증 범위는 위 변경과 그 의존 문맥입니다. 코드가 미커밋이므로 정확한 커밋 기준의 문서 전체 구현 적합성을 주장하지 않습니다. 실제 편집·투명 배경·Windows·비전 미지원 모델·codemode는 미확인으로 남깁니다. 추가 실제 이미지 호출은 하지 않습니다.

### 2026-10-05 — 정식 `openai` 공급자 조건 재확정

- 사용자는 구독 인증 자체도 deprecated된 `openai-codex`가 아니라 Pi의 정식 `openai`로 사용하겠다고 재확정했습니다. 중간 legacy 채택을 최종 정책으로 확대했던 결정을 대체합니다.
- 인증 조회·노출·로그인 안내를 `openai`로 통일하고, 계정 클레임 요구·토큰 해석·legacy 주소 변경·전용 헤더 생성을 제거합니다. Pi가 반환한 값·주소·추가 헤더를 보존하며 직접 이미지 도구 계약은 유지합니다. 편집의 내부 전송은 설치된 OpenAI Images SDK의 multipart 형식으로 맞추고, Responses 방식 전환은 하지 않습니다.
- 근거: 사용자 최종 조건, 로컬 Pi 1.0.2의 `openai` 구독 정의와 모델 레지스트리 계약, 정식 패키지 코드 및 `09-openai-provider.json` 검증 범위. `07`·`08`은 이전 단계의 이력으로 보존합니다.
- 이번 변경에서 추가 실제 이미지를 만들지 않았고, 이전 legacy 생성 성공을 최종 `openai` 구현의 성공으로 보고하지 않습니다.

### 2026-10-05 — 이미지 인증을 `openai-codex`로 확정

- Pi `openai` 토큰의 이미지 요청을 세 경로에서 실제로 시험했고 모두 거부됐습니다(401, 401, 400 `subscription_sharing_unsupported_capability`). 사용자는 이미지를 `openai-codex` 로그인으로 지원하기로 결정했습니다. 채팅은 기존 공급자를 그대로 씁니다.
- [9.1](#91-공급자와-인증-정책)의 인증·주소·헤더, [9.5](#95-요청-값-정책)의 JSON 편집, [9.9](#99-자격-증명-미설정-시-노출-정책)의 노출 기준, [9.10](#910-이미지-생성-스킬-정책)의 로그인 안내와 관련 문맥·대안·위험을 고쳤습니다. 도구 설명·스키마·저장·결과 안내는 그대로입니다.
- 검증: 빌드·정적 검사·로컬 검사와, 실제 Pi(`openai/gpt-6-astra` 채팅)에서 `image_gen` 1회 호출로 1254×1254 PNG 생성·저장을 확인했습니다(`11-openai-codex-image-auth.json`). 실제 편집·투명 배경은 미확인입니다.
