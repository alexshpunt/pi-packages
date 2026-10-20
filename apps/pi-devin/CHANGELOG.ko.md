# 변경 이력

0.1.2까지의 변경 이력은 영문 [CHANGELOG.md](CHANGELOG.md)에만 있습니다.

## [Unreleased]

## [0.1.3] - 2026-10-20

### 해결된 것

- `image_gen`처럼 매개변수 스키마가 `null`을 허용하는 도구가 있으면 `gemini-4-argon` 같은 Gemini 모델이 "There is an issue with this request, please try a different model" 오류로 실패하던 문제를 고쳤습니다. 이런 도구도 그대로 쓸 수 있으며, Devin 자체 도구처럼 매개변수마다 타입 하나로 선언됩니다.
- Claude·Gemini·GPT 모델의 정상 응답이 "stopReason cannot be treated as success" 또는 "Tool calls and the stop reason do not match" 오류로 실패하던 문제를 고쳤습니다. 이제 이 모델들의 도구 호출이 Pi에서 실행되고 최종 답변도 그대로 남습니다.
