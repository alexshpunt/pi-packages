# Ollama Cloud 확장 유지보수

`@buyong/pi-ollama-cloud`는 `pi-packages`의 독립 npm 앱입니다. 명령은 별도 표시가 없으면 모노레포 루트에서 실행합니다. Node.js 22.19 이상과 루트 `packageManager`에 지정된 pnpm을 사용합니다.

## 파일과 배포 경계

- `index.ts`: 공급자·명령 등록과 세션 수명 관리
- `models.ts`: 모델 조립과 `refreshModels`; 생성된 모델·가격·추론 수준·출력 한도 데이터를 사용
- `web-tools.ts`, `cache.ts`: 웹 도구와 디스크 캐시
- `config.ts`, `thinking-levels.ts`, `usage.ts`, `utils.ts`: 설정·추론 수준·사용량·공통 처리
- `scripts/`: 생성과 실서비스 검증. npm 배포 대상 아님
- `test/`: 기존 Vitest 검증. npm 배포 대상 아님

Pi는 TypeScript 소스를 직접 로드하므로 별도 빌드는 없습니다. 런타임 파일을 추가하면 `package.json`의 `files`에도 포함해야 합니다. `usage.ts`와 `utils.ts` 등은 외부에서 직접 import하므로 경로를 임의로 바꾸지 않습니다.

Pi 호스트 패키지와 `typebox`는 `peerDependencies: "*"`, 개발 의존성은 `catalog:`로 선언합니다. 공통 TypeScript 설정은 개발 의존성으로만 참조합니다. 배포용 archive는 `pnpm pack`으로 만들어 `workspace:`와 `catalog:`가 해석되게 합니다.

## 키 없이 검증

```bash
pnpm install --frozen-lockfile
pnpm --filter @buyong/pi-ollama-cloud check
pnpm --filter @buyong/pi-ollama-cloud test:unit
pnpm --dir apps/pi-ollama-cloud pack --pack-destination /tmp/pi-ollama-cloud-pack
```

모든 검사는 종료 코드 0이어야 합니다. `check`는 파일을 수정하지 않습니다. 생성 데이터 재조회는 이 검증의 일부가 아닙니다. 로드·명령 확인은 [README의 격리 실행](../README.md#개발과-검증)을 따릅니다.

## 생성 데이터 갱신

생성 파일은 직접 수정하지 않습니다. 다음 명령은 외부 API를 읽고 앱의 파일을 덮어쓰므로, 일반 검증과 구분해 실행합니다.

```bash
# 가격표 → models.dev 추론 수준 → 기본 모델 목록
pnpm --filter @buyong/pi-ollama-cloud generate-models

# 추론 수준만 갱신
pnpm --filter @buyong/pi-ollama-cloud generate-reasoning

# 모델별 출력 한도 측정: 인증과 실제 요청 사용량 필요
pnpm --filter @buyong/pi-ollama-cloud generate-limits
```

새 모델의 출력 한도를 반영하려면 `generate-limits`를 `generate-models`보다 먼저 실행합니다. 하나만 측정하려면 `generate-limits` 뒤에 정확한 모델 ID를 전달합니다. 인증은 Pi의 `auth.json`을 먼저 읽고 `OLLAMA_API_KEY`로 대체합니다.

가격표에 매칭되지 않은 모델, 측정 실패, 삭제된 모델을 검토하고 의도한 생성 결과만 커밋합니다. models.dev의 추론 데이터와 Ollama 모델 목록은 다른 데이터셋이므로 키 집합을 강제로 일치시키지 않습니다. 은퇴했지만 API에 남은 모델은 `scripts/generate-models.ts`의 `RETIRED_MODEL_IDS`에서 처리합니다.

## CI와 실서비스 검사

실행 주체는 루트 [pi-packages.yml](../../../.github/workflows/pi-packages.yml) 하나입니다.

| 상황 | 실행 |
| --- | --- |
| PR·main push | 변경된 앱의 린트·타입·단위 테스트·패키징 |
| 공통 설정·잠금 파일 변경 | 모든 공개 Pi 앱 검증 |
| Ollama 앱이 검증 대상으로 선택됨 | 최신 Pi 호환성 검사도 실행 |
| Ollama 대상 main push·수동 실행 | secret이 있으면 실서비스 검사. 없으면 생략 사유 기록 |
| Ollama 배포 태그 | 실서비스 검사 필수. 키가 없거나 검사에 실패하면 배포 차단 |

최신 Pi 검사는 별도 CI checkout의 개발 의존성만 갱신합니다. npm 배포는 커밋된 catalog와 잠금 파일을 사용하므로 최신 호환성 검사가 배포 의존성을 바꾸지 않습니다.

실서비스 검사에는 `buYoung/pi-packages`의 Actions secret `OLLAMA_CLOUD_API_KEY`가 필요합니다. 값은 실행 프로세스의 `OLLAMA_API_KEY`로 전달하며 PR에는 전달하지 않습니다. GitHub에서 기존 secret 값을 다시 읽어 복사할 수 없으므로 소유자가 새 저장소에 직접 등록합니다.

모델 검사와 thinking off 검사는 `pnpm pack` 결과를 풀어 로드합니다. 웹 API 검사는 기존 `scripts/smoke-web-tools.ts`를 실행합니다. 로컬에서 웹 API만 확인하려면 앱 디렉터리에서 `pnpm run smoke:web-tools`를 실행합니다. 이 명령은 키를 확인하고 실제 웹 검색·페이지 요청을 보냅니다.

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

1. `CHANGELOG.md`의 `[Unreleased]`에 실제 변경사항을 기록합니다. 사용자에게 정확한 다음 버전을 최종 확인받기 전에는 버전 변경이나 태그 생성을 하지 않습니다.
2. 승인 후 앱의 `package.json` 버전을 변경하고 `[Unreleased]` 내용을 `## [<버전>] - YYYY-MM-DD` 절로 옮깁니다. 위에 빈 `[Unreleased]` 절을 유지합니다. 배포기는 대괄호 유무 두 형식을 지원합니다.
3. 키 없는 검증을 실행하고 필요한 실서비스 검증을 확인합니다. 변경한 경로만 stage해 커밋한 뒤 `main`을 push합니다. 다른 앱의 버전은 바꾸지 않습니다.
4. 해당 커밋의 `Pi packages` workflow가 성공한 뒤 승인된 태그만 생성·push합니다. 아래 명령은 현재 앱의 버전을 읽습니다.

   ```bash
   version=$(node -p "require('./apps/pi-ollama-cloud/package.json').version")
   tag="pi-ollama-cloud-v${version}"
   git tag -a "$tag" -m "$tag"
   git push origin "$tag"
   ```

5. 태그 workflow의 검사·npm 배포·GitHub Release가 모두 성공했는지 확인하고 공개 레지스트리를 조회합니다.

   ```bash
   npm view @buyong/pi-ollama-cloud version repository --registry=https://registry.npmjs.org/
   ```

태그 실행은 해당 리비전을 다시 검증합니다. npm 배포가 성공한 뒤 GitHub Release 생성만 실패했다면 같은 버전을 다시 publish하지 말고 누락된 GitHub Release만 복구합니다. npm 배포 전 실패한 경우에도 원인과 레지스트리 상태를 먼저 확인합니다. 태그를 무작정 지우거나 덮어쓰지 않습니다.

## 원본 이력과 향후 변경 반영

`buYoung/pi-ollama-cloud`의 `main` 커밋 `2dcc3dd`까지의 이력을 `git subtree add`로 squash 없이 편입했습니다. 모노레포의 편입 커밋은 원본 커밋을 부모로 가지므로 Git 그래프에서 기존 이력을 확인할 수 있습니다.

원본인 [fgrehm/pi-ollama-cloud](https://github.com/fgrehm/pi-ollama-cloud)과 자동 동기화하지 않습니다. 필요할 때만 변경을 검토해 가져오고, 공통 TypeBox·Pi API·배포 경계와 기존 검증을 다시 확인합니다. 원저작자 라이선스와 변경 이력의 기여자 표기를 보존합니다.

이전한 저장소의 README·설명은 새 앱 위치를 안내하고 기존 배포 workflow를 중단합니다. 새 저장소의 첫 npm 배포가 성공한 뒤 기존 저장소를 보관 처리합니다. npm 패키지는 계속 유지하므로 `npm deprecate`하지 않습니다.
