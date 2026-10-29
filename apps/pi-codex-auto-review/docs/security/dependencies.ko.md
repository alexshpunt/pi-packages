# 의존성 보안 수정

[English](dependencies.md) | **한국어**

현재 소스는 `@anthropic-ai/sandbox-runtime`, 그 하위 의존성인 `node-forge`, `bundleDependencies`를 제거했습니다. 배포 패키지에는 `node_modules`가 없으며 Pi 호스트는 peer dependency로 씁니다. 런타임 의존성은 이 저장소의 `packages/redact`에서 배포하는 가림 엔진 `@buyong/redact` 하나뿐입니다. 이 의존성은 정확한 버전으로 고정되어 있고, 자체 런타임 의존성이 없으며, npm이 확장과 함께 설치합니다. 이 확장은 설치된 Pi 호스트의 의존성을 교체하지 않습니다.

## 현재 npm 배포

설치된 의존성의 `overrides`는 소비자 프로젝트에 적용되지 않으며, `package-lock.json`은 게시하지 않습니다. 이전 패키지에 묶었던 샌드박스 런타임은 현재 소스에서 제거했습니다. 게시 전 검사는 샌드박스 코드와 `node_modules`가 압축 파일에 남지 않았는지 확인합니다.

Pi 호스트는 `peerDependencies`로 두고 묶지 않습니다. `@buyong/redact`는 묶은 의존성이 아니라 일반 `dependencies` 항목이며, 배포 압축 파일에는 그 참조만 들어갑니다. 이 저장소의 개발용 잠금 파일은 별도로 설치된 Pi의 `brace-expansion` 버전을 바꾸거나 보장하지 않습니다.

패키지 디렉터리에서 `pnpm pack`을 실행하면 게시 전 검사가 적용됩니다. 현재 소스는 Rust 컴파일러나 플랫폼별 실행 파일 없이 JavaScript를 빌드·패키징하며, 소비자가 설치할 때 보안 보정용 설치 스크립트도 필요하지 않습니다. [저장소 배포 절차](https://github.com/buYoung/pi-packages/blob/main/README.ko.md#공통-ci와-패키지별-배포)를 참고하세요.

## 이 저장소의 개발 의존성

pi-packages에서는 루트 `pnpm-lock.yaml`의 Pi 1.4.0으로 개발합니다. 이 버전의 `minimatch`는 보정 없이 `brace-expansion 5.0.12`를 쓰며, `tests/unit/dependency-security.test.mjs`의 의존성 보안 검사 2개가 2026-10-29에 통과했습니다. 의존성을 갱신하면 실제 설치 버전을 확인하고 이 보안 회귀 검사를 다시 실행하세요.

이 결과는 이 저장소의 잠금 파일로 설치한 환경에 해당합니다. 별도로 설치한 Pi 호스트나 다른 프로젝트의 의존성은 바꾸지 않습니다. 다른 환경에서는 실제로 해석된 의존성과 그 환경의 감사 결과를 따로 확인해야 합니다.

## 과거 기록(0.1.4 이하)

다음 절은 현재 소스에는 없는 샌드박스 런타임을 포함해, 이전 버전에서 한 수정을 기록합니다.

### 0.1.3 배포 전 감사

2026-10-04 잠금 파일 기준으로 `npm audit --omit=dev --audit-level=high`는 취약점 0건을 보고했습니다. 개발 의존성을 포함한 `npm audit --audit-level=high`는 `release-it 21.0.1`의 하위 의존성 `basic-ftp`·`undici`와 그 상위 경로에서 높은 심각도 6건을 보고했습니다. 이 개발 도구는 배포 압축 파일에 포함되지 않습니다.

`npm audit fix --force`가 제안한 조치는 `release-it 20.2.0`으로 주 버전을 바꾸는 것이어서 그 릴리스에서는 적용하지 않았습니다. 개발 도구의 감사 항목은 미해결로 남았으며, 통과한 배포 의존성 감사와는 별개입니다.

### 이전 샌드박스 버전의 조치

이 기록은 샌드박스를 제거하기 전의 것입니다. 당시 높은 심각도 감사 항목 3건을 조치했고, 설치된 `node-forge 1.4.1-0`, `brace-expansion 5.0.12`와 감사 0건을 기록했습니다. 현재 개발 의존성 전체의 감사 결과를 뜻하지는 않습니다. 원래 근거는 [보안 검증 기록](https://github.com/buYoung/pi-packages/blob/main/docs/verification/auto-review/11-dependency-security.json)에 있습니다.

| 항목 | 적용한 수정 | 배포 상태 |
| --- | --- | --- |
| `node-forge`와 이를 쓰는 `sandbox-runtime` | RSA `DigestAlgorithm`의 추가 요소를 거부하는 [수정 PR](https://github.com/digitalbazaar/forge/pull/1152)의 커밋 `ceba34402e329f0365134f23fe19898756527d65`로 고정 | 공식 수정 릴리스가 아닌 **병합되지 않은 개발 버전**입니다. 1.4.0과 비교해 라이브러리 코드는 RSA 검증 부분만 바뀌었습니다. |
| `brace-expansion` | 공식 수정 버전 `5.0.12` 사용 | [공식 보안 공지](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)에 수정 버전으로 올라 있습니다. |

이 기록 당시 [`node-forge` 공식 공지](https://github.com/advisories/GHSA-86w9-cpqp-85rv)에는 수정 릴리스가 없었습니다. 버전을 임의로 올리거나 감사 결과를 숨기지 않았습니다. 실제 패치 소스로 고정한 뒤, 정상 PKCS#1·PSS 서명과 네이티브 암호 모듈이 거부하는 변형 서명으로 함께 검사했습니다.

### Pi 패키지의 잠금 보정

공식 Pi 0.99.1의 `npm-shrinkwrap.json`은 `brace-expansion 5.0.9`로 고정합니다. 이전 조치에서는 당시 확인한 설치 경로에서 루트 보정이 유지되지 않아, 개발용 압축 파일을 다시 포장해 썼습니다. 이 우회 구성은 0.1.4까지 포함되었습니다.

[pi-packages](https://github.com/buYoung/pi-packages)로 옮기기 전의 소스는 **공식 `@earendil-works/pi-coding-agent@0.99.1`을 직접 사용**했고, 레지스트리 무결성 값을 `package-lock.json`에 기록했습니다. 루트 보정과 커밋된 의존성 잠금으로 `brace-expansion 5.0.12`를 유지했습니다. 별도 디렉터리에서 처음부터 실행한 `npm ci --ignore-scripts`로 공식 SDK와 그 버전이 설치되었고, `npm install --package-lock-only --ignore-scripts`로 잠금 파일을 다시 만들어도 그대로였습니다. 기존 의존성 보안 검사 2개도 통과했습니다. SDK API 버전은 바뀌지 않았고, `vendor` 압축 파일·메타데이터·재포장 스크립트는 제거했습니다. 당시 단독 npm 저장소에서 실행한 확인 명령은 다음과 같으며, 현재 pnpm 모노레포에는 해당하지 않습니다.

```sh
npm ci --ignore-scripts
npm ls brace-expansion --all
npm run build
npm run test:contracts
npm audit --json
```

Docker와 CI도 같은 잠금 파일로 `npm ci`를 실행했으며, SDK 압축 파일 생성이나 설치 중 패치는 필요하지 않았습니다. 이전 압축 파일의 출처 기록은 [0.1.4 소스](https://github.com/buYoung/pi-codex-auto-review/blob/v0.1.4/vendor/pi-sdk-security.json)에 남아 있습니다.

### 확인한 결과

- 수정 전에는 `node-forge`가 정상 서명뿐 아니라 변형 서명도 `true`로 통과시켰고, `brace-expansion` 시험 입력은 5초 제한에 걸려 중단되었습니다.
- 수정 후에는 `node-forge`가 정상 서명을 그대로 통과시키고 변형 서명을 거부했으며, 같은 `brace-expansion` 입력도 제한 안에 끝났습니다.
- 계약·Pi 통합·네이티브 격리·패키지 실행을 다루는 로컬 검사 58개가 통과했습니다. 플랫폼 전체 집계와 실제 모델 재검증은 이후 기능 변경을 합친 최종 소스에서 하기로 미뤘습니다.
