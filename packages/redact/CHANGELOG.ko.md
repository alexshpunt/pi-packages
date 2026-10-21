# 변경 이력

## [Unreleased]

### 달라진 것

- README에 `normalizeRedactionConfig()`, `maskRanges`, `hideValue`, 호스트 추가 항목의 정확한 동작과, JSON 배열·`toJSON` 값·여러 줄 구간을 가리는 방식, Node.js 22가 거부하는 사용자 패턴 문법을 적었습니다.

## [0.1.4] - 2026-10-21

### 달라진 것

- 끝나지 않은 개인 키 시작 표식이 반복되어도 JSON 가림이 느려지지 않도록 개선했습니다. 가림 결과와 위치 정보는 그대로 유지합니다.
- 의료 행정번호 PII 탐지를 켰을 때 긴 공백 뒤의 비일치 입력으로 생기던 지연을 줄였습니다.

## [0.1.3] - 2026-10-20

### 달라진 것

- 소스 코드, 이슈, 릴리스 노트를 [pi-packages](https://github.com/buYoung/pi-packages) 저장소로 옮겼습니다.
