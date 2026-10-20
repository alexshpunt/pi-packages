# 의존성 보안 수정

[English](dependencies.md) | **한국어**

현재 소스는 `@anthropic-ai/sandbox-runtime`, 그 하위 `node-forge`, `bundleDependencies`를 제거했다. 배포 패키지에 `node_modules`를 포함하지 않으며 Pi 호스트는 peer dependency로 사용한다. 런타임 의존성은 이 저장소의 `packages/redact`에서 배포하는 가림 엔진 `@buyong/redact` 하나뿐이다. 정확한 버전으로 고정하며, 자체 런타임 의존성이 없고, npm이 확장과 함께 설치한다. 설치된 Pi의 의존성을 이 확장이 교체하지 않는다.

## 0.1.3 배포 전 감사

2026-10-04 잠금 파일 기준으로 `npm audit --omit=dev --audit-level=high`는 취약점 0건이다. 개발 의존성을 포함한 `npm audit --audit-level=high`는 `release-it 21.0.1`의 `basic-ftp`·`undici` 하위 의존성과 그 상위 경로에서 높은 심각도 6건을 보고했다. 이 개발 도구들은 배포 압축 파일에 포함되지 않는다.

`npm audit fix --force`가 제안하는 조치는 `release-it 20.2.0`으로의 주요 버전 변경이므로 이번 릴리스에서 적용하지 않았다. 개발 도구의 감사 항목은 미해결로 남기며, 배포 의존성의 감사 통과와 구분한다.

## 이전 샌드박스 버전의 조치 기록

아래는 샌드박스 제거 전의 기록이다. 당시 높은 심각도 3개 감사 항목을 조치했고, 설치된 `node-forge 1.4.1-0`, `brace-expansion 5.0.12`와 감사 0건을 기록했다. 현재 개발 의존성 전체의 감사 결과를 뜻하지 않는다. 원래 근거는 [보안 인계](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/11-dependency-security.json)에 보존한다.

| 항목 | 적용한 수정 | 배포 상태 |
| --- | --- | --- |
| `node-forge` 및 이를 사용하는 `sandbox-runtime` | RSA `DigestAlgorithm`의 추가 요소를 거부하는 [수정 PR](https://github.com/digitalbazaar/forge/pull/1152)의 커밋 `ceba34402e329f0365134f23fe19898756527d65`을 고정 | **미병합 개발 버전**이다. 공식 수정 릴리스로 표현하지 않는다. 기존 1.4.0 대비 라이브러리 코드 변경은 RSA 검증부 한 곳이다. |
| `brace-expansion` | 공식 수정 버전 `5.0.12` 사용 | [공식 보안 공지](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)에 기재된 수정 버전이다. |

당시 `node-forge`는 [공식 공지](https://github.com/advisories/GHSA-86w9-cpqp-85rv)에 수정 릴리스가 없다고 표시돼 있었다. 버전 문자열을 임의로 올리거나 감사를 억제하지 않았다. 실제 패치 소스를 고정하고 정상 PKCS#1·PSS 서명, 네이티브 암호 모듈이 거부하는 변형 서명을 함께 검사했다.

## Pi 패키지의 잠금 보정

공식 Pi 0.99.1의 `npm-shrinkwrap.json`은 `brace-expansion 5.0.9`를 고정한다. 이전 조치에서는 당시 확인한 설치 경로에서 루트 보정이 유지되지 않아 개발용 아카이브를 재포장했다. 이 우회 구성은 0.1.4까지 포함돼 있었다.

[pi-packages](https://github.com/buYoung/pi-packages)로 옮기기 전 소스는 **공식 `@earendil-works/pi-coding-agent@0.99.1`을 직접 사용**하고 레지스트리 무결성 값을 `package-lock.json`에 기록한다. 루트 보정과 커밋된 의존성 잠금으로 `brace-expansion 5.0.12`를 유지한다. 별도 디렉터리의 깨끗한 `npm ci --ignore-scripts`에서 공식 SDK와 해당 버전이 설치됐고, `npm install --package-lock-only --ignore-scripts`로 잠금을 갱신해도 유지됐다. 기존 의존성 보안 검사 2개도 통과했다. SDK API 버전은 그대로이며 `vendor` 아카이브·메타데이터·재포장 스크립트는 제거했다.

```sh
npm ci --ignore-scripts
npm ls brace-expansion --all
npm run build
npm run test:contracts
npm audit --json
```

Docker와 CI도 같은 잠금 파일로 `npm ci`를 실행했다. SDK 아카이브 생성이나 설치 중 패치는 필요하지 않았다.

pi-packages에서는 루트 `pnpm-lock.yaml`의 Pi 1.2.0으로 개발한다. 이 버전의 `minimatch`는 보정 없이 `brace-expansion 5.0.12`를 사용하며, `tests/unit/dependency-security.test.mjs`의 의존성 보안 검사 2개가 2026-10-20에 통과했다. 의존성을 갱신하면 실제 설치 버전을 확인하고 보안 회귀 검사를 다시 수행한다. 이전 아카이브의 출처 기록은 [0.1.4 소스](https://github.com/buYoung/pi-codex-auto-review/blob/v0.1.4/vendor/pi-sdk-security.json)에 보존돼 있다.

## 확인한 결과

- 수정 전 정상 서명은 통과했으나 변형 서명이 `true`로 승인됐다. 중괄호 확장 입력은 5초 제한으로 중단됐다.
- 수정 후 정상 서명은 유지되고 변형 서명은 거부됐다. 같은 중괄호 입력도 제한 안에 완료됐다.
- 기존 계약·Pi 통합·네이티브 격리·패키지 실행을 합친 로컬 검증 58개가 통과했다. 플랫폼 전체 집계와 실모델 재검증은 후속 기능 변경을 합친 최종 소스에서 수행한다.

이 보정은 저장소의 잠금 파일로 설치한 환경에 적용된다. 별도로 설치된 Pi 호스트나 다른 프로젝트의 의존성을 자동으로 바꾸지는 않는다. 다른 환경에서는 실제로 해석되는 의존성과 해당 환경의 감사 결과를 별도로 확인해야 한다.

## 현재 npm 배포

설치된 의존성의 `overrides`는 소비자 프로젝트에 적용되지 않고 `package-lock.json`도 게시되지 않는다. 이전 패키지에 묶었던 샌드박스 런타임은 현재 소스에서 제거했다. 게시 전 검사는 샌드박스 코드와 `node_modules`가 압축 파일에 남지 않는지 확인한다.

Pi 호스트는 `peerDependencies`로 유지하고 묶지 않는다. `@buyong/redact`는 묶은 의존성이 아니라 일반 `dependencies` 항목이며, 배포 압축 파일에는 그 참조만 들어간다. 저장소의 개발용 잠금 파일은 별도로 설치된 Pi의 `brace-expansion` 버전을 변경하거나 보장하지 않는다.

패키지 디렉터리에서 `pnpm pack`을 실행하면 게시 전 검사가 적용된다. 현재 소스는 Rust 컴파일러나 플랫폼별 실행 파일 없이 JavaScript를 빌드·패키징한다. 소비자 설치에도 보안 보정을 위한 설치 스크립트를 요구하지 않는다. [저장소 배포 절차](https://github.com/buYoung/pi-packages#공통-ci와-패키지별-배포)를 따른다.
