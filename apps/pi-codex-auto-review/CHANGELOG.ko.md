# 변경 이력

## [Unreleased]

## [0.6.0] - 2026-10-20

### 달라진 것

- 보호 CLI와 SDK가 Pi 1.0.0 이상에서 시작합니다. 1.0.0·1.1.0이 아닌 Pi 버전도 더는 `UNSUPPORTED_PI`로 실패하지 않으며, 1.0.0 미만은 계속 거부합니다.
- 소스 코드, 이슈, 릴리스 노트를 [pi-packages](https://github.com/buYoung/pi-packages) 저장소로 옮겼습니다.

### 제거된 것

- npm 압축 파일에서 `docs/publishing.md`와 `docs/publishing.ko.md`를 뺐습니다. 릴리스는 pi-packages 저장소의 절차를 따릅니다.
