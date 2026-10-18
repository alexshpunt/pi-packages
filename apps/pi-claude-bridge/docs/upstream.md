# bridge에 upstream 변경 가져오기

`apps/pi-claude-bridge`는 `elidickinson/pi-claude-bridge`의 Git 이력을 보존한 subtree입니다. 별도 GitHub fork 없이 원본 변경을 이 앱에 병합할 수 있습니다. **이 문서는 수동 절차만 제공하며, remote 연결이나 자동 동기화를 설정하지 않습니다.**

## 시작 조건

- `pi-packages` 저장소 루트에서 실행합니다.
- Git과 `git subtree`, Node.js 22.19 이상, 저장소에 지정된 pnpm이 필요합니다.
- 진행 중인 병합과 커밋하지 않은 변경이 없어야 합니다. 기존 작업은 먼저 별도로 보존합니다.
- GitHub의 원본 저장소를 읽을 수 있어야 합니다. 이 절차는 원본에 push하지 않습니다.
- upstream 병합과 npm 배포는 별도 작업입니다. 병합만으로 배포 태그를 만들지 않습니다.

## 1. 별도 작업 브랜치 만들기

```bash
git status --short
git switch main
git pull --ff-only origin main
git switch -c chore/bridge-upstream
```

`git status --short`에 변경이 있으면 먼저 정리하고 다음 명령을 실행합니다. 작업 브랜치 이름이 이미 존재하면 사용하지 않은 이름으로 바꿉니다. 이후 커밋 제목에는 실제 작업 브랜치명을 사용합니다.

## 2. 필요할 때만 원본 연결하기

먼저 기존 remote를 확인합니다.

```bash
git remote -v
```

`bridge-upstream`이 없을 때만 다음 명령을 실행합니다. 이미 있다면 URL이 아래 원본 주소와 같은지 확인하고 재등록하지 않습니다.

```bash
git remote add bridge-upstream https://github.com/elidickinson/pi-claude-bridge.git
git config remote.bridge-upstream.tagOpt --no-tags
```

변경을 가져오되 원본의 `v*` 릴리스 태그는 가져오지 않습니다.

```bash
git fetch --no-tags bridge-upstream main
git log --oneline HEAD..bridge-upstream/main
```

출력은 아직 현재 브랜치에 포함되지 않은 upstream 커밋입니다. 이 단계에서는 작업 파일이 바뀌지 않습니다. 가져올 변경의 범위와 의존성·호환성 변경을 검토한 뒤 진행합니다.

## 3. 앱 디렉터리에 병합하기

다음 명령은 충돌이 없으면 병합 커밋까지 만듭니다. 최초 편입이 전체 이력을 보존했으므로 **`--squash`를 추가하지 않습니다.**

```bash
message=$(printf 'chore(bridge upstream 병합): %s\n\n1. 원본 변경을 bridge 앱에 병합' "$(git branch --show-current)")
git subtree merge --prefix=apps/pi-claude-bridge --message "$message" bridge-upstream/main
```

충돌이 생기면 `git status`로 확인하고 파일별로 해결합니다. 모노레포 변경을 보존해야 하는 주요 항목은 다음과 같습니다.

| 항목 | 유지할 기준 |
| --- | --- |
| `package.json` | npm 이름 `@buyong/pi-claude-bridge`, 모노레포 저장소 메타데이터, `pi.extensions` 진입점 |
| 호스트 의존성 | Pi·typebox는 `peerDependencies: "*"`, 개발 버전은 루트 catalog |
| 잠금 파일 | 앱의 `package-lock.json`이 아니라 루트 `pnpm-lock.yaml` |
| CI/CD | 저장소 루트의 공통 `.github/workflows/pi-packages.yml`. 앱 안의 `.github/workflows/`는 실행되지 않음 |
| 릴리스 | 독립 버전, `pi-claude-bridge-v*` 태그, 모노레포용 릴리스 스크립트와 npm OIDC 설정 |
| 연동 코드 | compact 연동 등 이 배포판에서 유지하는 변경 |
| 저작권 | 기존 LICENSE와 원저작자 표기 |

upstream의 의존성·기능 변경은 필요한 내용을 검토해 반영합니다. 충돌을 없애기 위해 한쪽 파일을 일괄 덮어쓰지 않습니다. 해결한 파일만 Git index에 추가한 뒤 병합을 완료합니다.

병합 중 중단하려면 다음 명령을 사용합니다. 병합 시작 후 직접 작성한 해결 내용도 사라지므로 필요한 내용은 먼저 별도로 보존합니다.

```bash
git merge --abort
```

이미 병합 커밋이 생긴 뒤에는 `git merge --abort`가 적용되지 않습니다. 공유된 브랜치를 강제로 되돌리지 말고, 변경 상태를 확인한 뒤 별도 되돌리기 커밋을 검토합니다.

## 4. 검증하고 변경 범위 확인하기

저장소 루트에서 실행합니다.

```bash
pnpm install
pnpm --filter @buyong/pi-claude-bridge typecheck
pnpm --filter @buyong/pi-claude-bridge test:unit
pnpm --dir apps/pi-claude-bridge pack
git diff --stat origin/main...HEAD
git status --short
```

타입 검사와 단위 테스트가 종료 코드 0으로 끝나고, 앱 디렉터리에 배포용 `.tgz`가 생성되는지 확인합니다. 변경된 manifest·루트 잠금 파일과 병합 결과도 검토합니다. 새로운 SDK나 Claude Code 동작에 의존하는 변경이라면 해당 기존 통합 테스트를 별도로 실행합니다. 통합 테스트는 실제 API·인증과 사용량이 필요합니다.

검증 후 작업 브랜치를 검토해 `main`에 반영합니다. 배포할 때만 [README의 배포 절차](../README.md#배포와-upstream-갱신)를 따릅니다. 원본의 `v*` 태그를 push하거나 `git push --tags`를 사용하지 않습니다.

## 연결을 남기지 않으려면

병합을 마친 뒤 원본 remote만 제거할 수 있습니다. 이미 병합한 커밋 이력은 남습니다.

```bash
git remote remove bridge-upstream
git remote -v
```

출력에 `bridge-upstream`이 없으면 연결 제거가 끝난 것입니다. 다음 갱신 때 2단계부터 다시 등록하면 됩니다.
