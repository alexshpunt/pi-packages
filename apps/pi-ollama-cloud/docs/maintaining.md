# Ollama Cloud 확장 유지보수

`@buyong/pi-ollama-cloud`는 `pi-packages`의 독립 npm 앱입니다. 명령은 별도 표시가 없으면 모노레포 루트에서 실행합니다. Node.js 22.19 이상과 루트 `packageManager`에 지정된 pnpm을 사용합니다.

## 파일과 배포 경계

- `src/index.ts`: Pi 등록과 `src/pi/`의 명령·도구·세션 연결. `package.json`의 `pi.extensions`가 이 파일을 지정
- `src/{auth,models,cache,web,render,usage,shared}/`: 공용 runtime 구현. CLI와 실제 확장이 함께 사용
- `src/generated/catalog.generated.ts`: 모델·가격·추론 데이터와 출처를 함께 보관하는 단일 artifact
- `src/generated/limits.generated.ts`: 별도 출력 한도 측정 결과
- `scripts/cli/`: 중앙 메뉴와 01~11 진단. `scripts/lib/`: 생성·배포물·실서비스 검증
- `test/`: Vitest·subprocess·SDK/TUI fixture. `scripts/`와 함께 npm 배포에서 제외

Pi는 TypeScript 소스를 직접 로드하므로 별도 빌드는 없습니다. `package.json`의 `files`는 `src/`와 배포 문서만 포함합니다. 루트 `.ts` 파일과 generated 재노출 파일은 제거했으며, 직접 import하는 소비자는 `src/`의 구현 경로를 사용합니다. 개발 스크립트와 검증 코드를 `src/`로 옮기지 않습니다.

Pi 호스트 패키지와 `typebox`는 `peerDependencies: "*"`, 개발 의존성은 `catalog:`로 선언합니다. `proper-lockfile`은 생산 의존성이고 Inquirer·tsx·검증 라이브러리는 개발 전용입니다. 공통 TypeScript 설정은 개발 의존성으로만 참조합니다. 배포용 archive는 `pnpm pack`으로 만들어 `workspace:`와 `catalog:`가 해석되게 합니다.

## 키 없이 검증

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-ollama-cloud check
pnpm --filter @buyong/pi-ollama-cloud test:unit
verification_dir="$(mktemp -d)"
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/verify.ts --offline --report "$verification_dir/offline.json"
pnpm --dir apps/pi-ollama-cloud pack --pack-destination "$verification_dir/package"
```

모든 검사는 종료 코드 0이어야 합니다. `check`는 파일을 수정하지 않습니다. 생성 데이터 재조회는 이 검증의 일부가 아닙니다. 로드·명령 확인은 [README의 격리 실행](../README.ko.md#개발과-검증)을 따릅니다.

## 생성 데이터 갱신

생성 파일은 직접 수정하지 않습니다. 일반 검증은 fixture만 사용합니다. 다음 명령은 외부 자료를 읽거나 실제 사용량을 발생시키므로 목적을 구분합니다.

```bash
# 전체 catalog를 수집·검증하지만 게시하지 않음 (공개 API/문서 조회)
pnpm --filter @buyong/pi-ollama-cloud generate-models --dry-run

# 임시 파일을 완성한 뒤 src/generated/catalog.generated.ts 한 번 교체
pnpm --filter @buyong/pi-ollama-cloud generate-models

# 기존 진입점도 이제 가격·모델·추론 전체 transaction을 실행
pnpm --filter @buyong/pi-ollama-cloud generate-reasoning

# 별도 출력 한도 측정: 인증과 실제 추론 사용량 필요
pnpm --filter @buyong/pi-ollama-cloud generate-limits <exact-model-id>
```

`generate-models.ts`, `generate-pricing.ts`, `generate-reasoning.ts`는 같은 완전한 파이프라인을 사용합니다. 후보 목록을 한 번 모으고 모든 상세·가격·추론 자료와 최종 형식을 검사한 뒤 단일 catalog를 교체합니다. 일부 상세 실패·빈 목록·원본 schema 오류·쓰기/rename 실패는 기존 결과를 보존합니다. 프로세스가 rename 직전·직후 죽는 경우는 이전 또는 완성본만 관찰하도록 검증했으며, 전원 장애 내구성까지 보장하는 것은 아닙니다.

기본 출력 디렉터리는 앱의 `src/generated/`입니다. `--output-dir <dir>`를 지정하면 그 디렉터리에 `catalog.generated.ts` 또는 `limits.generated.ts`를 직접 씁니다. `--dry-run`은 게시만 막습니다. **`generate-limits --dry-run`도 실제 유료 추론을 실행합니다.** 인증은 공식 Pi resolver로 저장 키를 해석하고 없으면 `OLLAMA_API_KEY`로 대체합니다. 동기 `!command`의 취소는 최대 10초 늦어질 수 있습니다.

출력 한도의 정확한 측정값과 확인된 하한을 구분합니다. 모호한 실패는 기존 값을 유지하고, 전부 실패하거나 유효한 결과가 없으면 파일을 덮어쓰지 않습니다. 새 한도를 catalog에 반영하려면 limits 측정 후 catalog를 생성합니다.

표준 가격과 Off-Peak 가격을 섞지 않습니다. 미확인 별칭 가격은 무료로 확정하지 않으며, models.dev와 Ollama의 키 집합을 강제로 일치시키지 않습니다. API에 남은 은퇴 모델을 자동 제외하는 목록은 현재 없으므로 게시 전에 은퇴 공지도 검토합니다. 기존 데이터 이관의 관찰 시각은 알 수 없는 경우 `null`로 유지합니다.

## CI와 실서비스 검사

실행 주체는 루트 [pi-packages.yml](../../../.github/workflows/pi-packages.yml) 하나입니다.

| 상황 | 실행 |
| --- | --- |
| PR·main push | 변경된 앱의 린트·타입·단위 테스트·패키징, Ollama는 추가 offline source/artifact 계약 검증 |
| 공통 설정·잠금 파일 변경 | 모든 공개 Pi 앱 검증 |
| Ollama 앱이 검증 대상으로 선택됨 | 최신 Pi 호환성 검사도 실행 |
| Ollama 대상 main push·수동 실행 | secret이 있으면 실서비스 검사. 없으면 생략 사유 기록 |
| Ollama 배포 태그 | 실서비스 검사 필수. 키가 없거나 검사에 실패하면 배포 차단 |

최신 Pi 검사는 별도 CI checkout의 개발 의존성만 갱신합니다. npm 배포는 커밋된 catalog와 잠금 파일을 사용하므로 최신 호환성 검사가 배포 의존성을 바꾸지 않습니다.

실서비스 검사에는 `buYoung/pi-packages`의 Actions secret `OLLAMA_CLOUD_API_KEY`가 필요합니다. 값은 실행 프로세스의 `OLLAMA_API_KEY`로 전달하며 PR에는 전달하지 않습니다. GitHub에서 기존 secret 값을 다시 읽어 복사할 수 없으므로 소유자가 새 저장소에 직접 등록합니다.

모델·thinking-off·웹 검사는 `pnpm pack` archive를 별도 디렉터리에 생산 의존성과 함께 설치한 결과를 로드합니다. Pi peer는 실행 중인 호스트가 제공합니다. 설치는 `--ignore-scripts --legacy-peer-deps --omit=dev`로 개발 의존성·중복 Pi 설치를 피합니다. offline gate는 기존 로컬 의존성을 복사하므로 registry에서의 신규 설치 증명과는 구분합니다.

웹 검사는 `scripts/smoke-web-tools.ts --package-dir <installed-package>`로 실제 등록된 execute·반환 상한·보관된 캐시 재사용을 확인합니다. 앱 디렉터리의 `pnpm run smoke:web-tools`는 source 경로를 검사하며 검색·fetch 각 1회와 구매 크레딧 보호를 위한 `/api/balance` 조회 1회를 사용합니다. 실패는 자동 재시도하지 않습니다.

수동 최소 검증은 별도의 명시적 예산 승인 후에만 다음 형태로 실행합니다. 기존 CI의 추가 모델·thinking-off 검사를 대체하는 명령이 아닙니다.

```bash
pnpm --filter @buyong/pi-ollama-cloud exec tsx scripts/cli/live.ts --live-minimal --package-dir <installed-package> --report <new-report.json>
```

공용 채팅 경로에서 `glm-5.3-flash:cloud`에 `1+1` 1회(120,000ms, 최대 4,096 토큰), 등록된 웹 도구에서 `Ollama Cloud` 검색 1회(3개 결과), `https://ollama.com` fetch 1회입니다. 실패도 횟수에 포함하며 이후 단계는 중단합니다. 같은 보고서 경로는 재실행을 거절하고, 전송 전 호출 수를 기록합니다. redirect·추가 요청·retry는 전송 전에 차단합니다. 인증값·전체 응답은 기록하지 않습니다. cache replay는 실제 보관된 항목에만 수행하고 추가 전송을 차단합니다.

`docs/verification/ollama-cloud/`는 역사적 CLI/consumer 기록을 보존합니다. 01–11 기록은 루트 호환 파일을 유지했던 이전 구조의 증거입니다. 후속 수정·경로 이동은 관련 진단·최종 소비자 검증을 다시 실행하고 별도 기록에 현재 해시와 명령을 남깁니다. 단순 해시 교체는 검증이 아닙니다. PTY/TUI 확인은 `python3 apps/pi-ollama-cloud/test/fixtures/run-render-tui.py --report <temp-report.json>`이며, mock renderer callback이나 별도 GUI 육안 검사와 구분합니다.

## npm 배포 출처 설정

npm의 `@buyong/pi-ollama-cloud` 패키지 설정에서 Trusted Publisher를 다음과 같이 설정합니다.

| 필드 | 값 |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `buYoung` |
| Repository | `pi-packages` |
| Workflow filename | `pi-packages.yml` |
| Environment | 비워 둠 |
| Allowed actions | 직접 `npm publish` 허용 |

GitHub-hosted runner의 Node 24와 npm 11.5.1 이상을 사용합니다. 별도 `NPM_TOKEN`은 필요 없습니다. `repository.url`도 실제 배포 저장소인 `buYoung/pi-packages`를 가리켜야 합니다. [npm Trusted Publishing 문서](https://docs.npmjs.com/trusted-publishers/)를 참고하세요.

## 버전과 배포 절차

배포는 npm 이름이 아니라 **앱 폴더명을 붙인 태그**로 선택합니다. 예를 들어 `pi-ollama-cloud-v0.13.2`는 이 앱만 배포합니다. 기존의 `v*` 태그는 사용하지 않습니다.

이전 당시 npm 최신과 `package.json`은 `0.13.0`이었지만 원본 CHANGELOG에는 `0.13.1` 항목이 있었습니다. 그 기록은 그대로 보존합니다. 새 버전은 npm에 없는 버전이면서 기존 변경 이력과 중복되지 않게 선택합니다. 이미 게시한 버전은 다시 게시할 수 없습니다.

1. `CHANGELOG.md`(영문)와 `CHANGELOG.ko.md`(한글)의 `[Unreleased]`에 사용자가 알아차릴 변경사항을 같은 하위 절로 기록합니다. 빠진 항목은 4단계에서 `claude -p`가 초안을 만듭니다. 사용자에게 정확한 다음 버전을 최종 확인받기 전에는 버전 변경이나 태그 생성을 하지 않습니다.
2. 키 없는 검증을 실행하고 필요한 실서비스 검증을 확인합니다. 변경한 경로만 stage해 커밋한 뒤 `main`을 push하고, 해당 커밋의 `Pi packages` workflow가 성공했는지 확인합니다.
3. 저장소 루트에서 준비 상태를 확인합니다. 파일·Git·원격을 바꾸지 않고 JSON으로 결과(`ready`, `blockers`)를 출력합니다.

   ```bash
   pnpm release:dry-run --app pi-ollama-cloud --version <승인된 버전>
   ```

4. 사용자가 터미널에서 `pnpm release`를 실행해 `@buyong/pi-ollama-cloud`를 고릅니다. `claude -p`가 두 변경 이력에 빠진 항목의 초안을 보여 주면 확인 후 기록하고, 승인된 버전을 고른 뒤 커밋·태그·push를 하나씩 확인합니다. 이 명령이 `package.json` 버전을 올리고 두 파일의 `[Unreleased]` 내용을 `## [<버전>] - YYYY-MM-DD` 절로 옮기며 위에 빈 `[Unreleased]` 절을 남깁니다. push는 `main`과 `pi-ollama-cloud-v<버전>` 태그만 전송하고 다른 앱의 버전은 바꾸지 않습니다.
5. 태그 workflow의 검사·npm 배포·GitHub Release가 모두 성공했는지 확인하고 공개 레지스트리를 조회합니다.

   ```bash
   npm view @buyong/pi-ollama-cloud version repository --registry=https://registry.npmjs.org/
   ```

태그 실행은 해당 리비전을 다시 검증합니다. npm 배포가 성공한 뒤 GitHub Release 생성만 실패했다면 같은 버전을 다시 publish하지 말고 누락된 GitHub Release만 복구합니다. npm 배포 전 실패한 경우에도 원인과 레지스트리 상태를 먼저 확인합니다. 태그를 무작정 지우거나 덮어쓰지 않습니다.

## 원본 이력과 향후 변경 반영

`buYoung/pi-ollama-cloud`의 `main` 커밋 `2dcc3dd`까지의 이력을 `git subtree add`로 squash 없이 편입했습니다. 모노레포의 편입 커밋은 원본 커밋을 부모로 가지므로 Git 그래프에서 기존 이력을 확인할 수 있습니다.

원본인 [fgrehm/pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud)과 자동 동기화하지 않습니다. 필요할 때만 변경을 검토해 가져오고, 공통 TypeBox·Pi API·배포 경계와 기존 검증을 다시 확인합니다. 원저작자 라이선스와 변경 이력의 기여자 표기를 보존합니다.

이전한 저장소의 README·설명은 새 앱 위치를 안내하고 기존 배포 workflow를 중단합니다. 새 저장소의 첫 npm 배포가 성공한 뒤 기존 저장소를 보관 처리합니다. npm 패키지는 계속 유지하므로 `npm deprecate`하지 않습니다.
