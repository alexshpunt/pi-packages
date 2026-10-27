# pi-mcp-adapter

[English](README.md) | **한국어**

[MCP](https://modelcontextprotocol.io) 서버를 [Pi](https://github.com/earendil-works/pi)에 연결합니다. Pi에 내장된 MCP 지원을 대신하며, 동작은 같습니다. 같은 `mcp.json`을 읽고, 같은 `/mcp` 관리 화면을 제공하며, 도구를 같은 방식으로 노출합니다. 여기에 두 가지가 더해집니다.

- **출력 한도 설정.** Pi는 긴 MCP 결과를 20KB에서 자릅니다. 이 확장에서는 도구, 서버, `mcp.json`이 다른 한도를 정할 수 있습니다([도구 출력 한도](#도구-출력-한도) 참고).
- **다른 확장에 도구 `_meta` 제공.** MCP 도구마다 서버가 선언한 `_meta`를 보관하고, 다른 확장이 이를 읽을 수 있습니다([다른 확장에서 도구 `_meta` 읽기](#다른-확장에서-도구-_meta-읽기) 참고).

## 요구 사항

- Node.js 22.19.0 이상
- Pi 1.4.0(1.4.0에서 확인)

## 설치

이 패키지는 아직 npm에 없습니다. 이 저장소의 체크아웃에서 설치하세요. Pi는 로컬 패키지의 의존성을 설치하지 않으므로 의존성을 먼저 설치하세요.

```bash
cd /path/to/pi-packages
pnpm install
pi install /path/to/pi-packages/apps/pi-mcp-adapter
```

그다음 Pi에 내장된 MCP 지원을 끄세요. 그러면 이 확장만 `mcp.json`을 읽습니다. `~/.pi/agent/settings.json`의 `extensions`에 `-builtin:mcp`를 넣으세요.

```json
{
  "extensions": ["-builtin:mcp"]
}
```

`pi config`의 **Built-in**에서 `mcp`를 꺼도 됩니다. 끄지 않아도 이 확장이 MCP를 맡지만, 내장 지원이 켜져 있는 동안 Pi는 시작할 때마다 다음 경고를 출력합니다.

```text
Warning: Extension package "builtin:mcp": Extension <path>/src/index.ts registers command `/mcp`, so built-in extension `mcp` was not loaded. …
```

Pi를 다시 시작하거나 실행 중인 Pi에서 `/reload`를 실행하세요. Pi는 로컬 패키지를 복사하지 않고 그 디렉터리에서 불러오므로 체크아웃을 그대로 두세요.

설치하지 않고 한 세션에서만 써 보려면 `pi -e /path/to/pi-packages/apps/pi-mcp-adapter`로 Pi를 시작하세요.

## 서버 설정

서버는 `~/.pi/agent/mcp.json`과, 신뢰한 프로젝트에서는 `.pi/mcp.json`에서 읽습니다. 프로젝트 항목은 같은 이름의 전역 항목을 대신합니다. 다만 `command`, `url`, `type`이 없는 프로젝트 항목은 전역 항목의 `enabled`, `exposure`, `toolExposure`만 바꾸고 나머지는 그대로 둡니다. 형식은 다른 MCP 클라이언트가 쓰는 `mcpServers` 형태입니다.

```json
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
    "docs": { "url": "https://example.com/mcp", "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" } }
  }
}
```

Pi 내장 MCP 지원의 설정은 모두 같은 방식으로 동작합니다. 자세한 내용은 [Pi의 MCP 문서](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)를 참고하세요.

| 설정 | 위치 | 의미 |
| --- | --- | --- |
| `command`, `args`, `env`, `cwd` | 서버 | stdio 서버 |
| `url`, `headers`, `oauth`, `auth` | 서버 | streamable HTTP 서버와 로그인 방식 |
| `exposure`, `toolExposure` | 서버 | 도구가 모델에 닿는 방식: `codemode`(기본), `deferred`, `direct`, `hidden` |
| `description` | 서버 | 서버가 제공하는 것을 설명하는 한 문장 |
| `enabled` | 서버 | `false`이면 항목은 두고 연결하지 않음 |
| `timeout` | 서버 | 요청당 초(기본 60) |
| `maxOutputBytes` | 서버, 최상위 | 출력 한도(바이트, [도구 출력 한도](#도구-출력-한도) 참고) |
| `autoEnableCodemode` | 최상위 | `false`이면 `codemode` 도구를 켜지 않음 |

확장이 `pi.registerMcpServer()`로 등록한 서버도 연결합니다. 이름이 같으면 `mcp.json`의 서버가 우선합니다.

## 도구 출력 한도

도구 결과의 텍스트가 한도보다 길면 모델은 앞부분과 뒷부분만 받고, 가운데에는 `…N chars truncated…` 표시가 들어갑니다. 전체 텍스트는 임시 파일에 저장되고, 결과에 그 파일 경로가 나옵니다. 한도(바이트)는 다음 중 처음으로 설정된 값입니다.

1. 서버가 도구의 `tools/list` 항목에 둔 `_meta["pi/maxOutputBytes"]`
2. 서버 항목의 `maxOutputBytes`
3. `mcp.json` 최상위의 `maxOutputBytes`. 프로젝트 값이 전역 값을 대신합니다.
4. 그 밖에는 20KB(20480바이트)

```json
{
  "maxOutputBytes": 51200,
  "mcpServers": {
    "docs": { "url": "https://example.com/mcp", "maxOutputBytes": 204800 }
  }
}
```

서버는 도구마다 이렇게 한도를 선언합니다.

```json
{ "name": "dump_schema", "inputSchema": { "type": "object" }, "_meta": { "pi/maxOutputBytes": 200000 } }
```

값은 모두 양의 정수여야 합니다.

- `mcp.json`의 잘못된 값은 설정 오류입니다. Pi가 시작할 때와 `/mcp`에서 알려 줍니다. 값이 잘못된 서버는 연결하지 않고, 잘못된 최상위 값은 무시합니다.
- 확장이 잘못된 `maxOutputBytes`로 등록한 서버도 같은 방식으로 알리고 연결하지 않습니다.
- 도구 `_meta`의 `pi/maxOutputBytes`가 잘못되면 무시하고 2~4단계를 적용합니다.

리소스 도구 가운데 `read_mcp_resource`와, `server`를 지정해 호출한 `list_mcp_resources`·`list_mcp_resource_templates`는 2~4단계를 씁니다. 두 목록 도구를 `server` 없이 호출하면 3~4단계를 씁니다. codemode 스크립트는 항상 전체 결과를 받습니다.

## 다른 확장에서 도구 `_meta` 읽기

MCP 도구마다 `tools/list` 항목의 `_meta` 객체를 서버가 보낸 그대로 보관합니다. 이 값은 모델에 보내지 않습니다. Pi 1.4.0의 `pi.getAllTools()`는 이 값을 알려 주지 않으므로, 이 확장이 `pi.events`의 `tool-meta` 채널로 들어오는 요청에 답합니다.

```ts
const meta: Record<string, Record<string, unknown>> = {};
pi.events.emit("tool-meta", { reply: (tools) => Object.assign(meta, tools) });
// meta["mcp__docs__search"]는 서버 `docs`의 도구 `search`의 `_meta`입니다.
```

- `reply`는 `emit`이 반환되기 전에 호출됩니다.
- 키는 Pi 도구 이름(`mcp__<server>__<tool>`)이며, 활성화되지 않은 도구도 들어갑니다.
- `_meta`가 객체인 도구만 들어갑니다. 리소스 도구에는 없습니다.
- 응답마다 사본을 주므로, 받은 값을 바꿔도 이 확장의 값은 바뀌지 않습니다.
- 다른 확장도 이 채널에 답할 수 있습니다. 확장마다 자기 도구로 `reply`를 호출하므로 응답을 합쳐서 쓰세요.

도구 정의에도 같은 객체가 `meta`로 들어 있습니다. `pi.getAllTools()`가 `meta`를 알려 주는 Pi 버전에서는 그곳에도 나옵니다.

## 서버 관리

- `/mcp`는 관리 화면을 엽니다. 서버별 상태와 도구를 보여 주고, 로그인, 로그아웃, 다시 연결, 서버 켜기·끄기, 노출 방식 변경을 할 수 있습니다.
- 켜기·끄기와 노출 방식 변경은 그 서버를 정의한 `mcp.json`에 저장됩니다. **Enable in this project**와 **Disable in this project**는 프로젝트의 `.pi/mcp.json`에 저장합니다. 확장이 등록한 서버라면 변경은 해당 세션에만 적용됩니다.
- `/mcp login [server]`, `/mcp logout [server]`, `/mcp reconnect [server]`는 관리 화면을 열지 않고 로그인, 로그아웃, 다시 연결을 합니다.
- 대화형 TUI가 아니면 `/mcp`는 서버 상태를 출력합니다.

OAuth 인증 정보는 Pi와 같은 파일인 `~/.pi/agent/mcp-auth.json`에 저장됩니다. 서버 로그 메시지는 `~/.pi/agent/mcp.log`에 덧붙입니다.

## Pi 내장 MCP 지원과 다른 점

- 위의 출력 한도와 도구 `_meta`
- `pi mcp` 셸 명령(`pi mcp add`, `pi mcp login` 등)은 여전히 Pi 내장 구현이 실행합니다. 같은 `mcp.json`과 `mcp-auth.json`을 읽고 쓰므로, 이 확장도 그 변경을 봅니다.
- 명령을 실행하는 설정값(`env`, `headers`, `oauth.clientSecret`의 `"!command"`)은 시스템 기본 셸에서 실행됩니다. Windows에서는 Pi에 설정한 셸이 아니라 `cmd.exe`입니다. Pi는 명령을 프로세스마다 한 번 실행하지만, 이 확장은 연결할 때마다 다시 실행합니다.

## 개발과 검증

저장소 루트에서 `pnpm install`을 실행한 뒤 `apps/pi-mcp-adapter`에서 다음 명령을 실행하세요.

```bash
pnpm run typecheck
pnpm run lint
pnpm run test:unit
```

`test:unit`은 메모리 안의 MCP 서버로 확장을 실행합니다. 한도 적용 순서, 설정 검증, `tool-meta` 채널, 그리고 시작부터 `/mcp` 동작을 거쳐 종료까지의 서버 연결을 확인합니다.

Pi에서 직접 확인하려면 `~/.pi/agent/mcp.json`에 서버를 추가하고 `pi -e /path/to/pi-packages/apps/pi-mcp-adapter`로 시작한 뒤 `/mcp`를 실행하세요. 관리 화면에 그 서버가 도구 개수와 함께 `connected`로 나옵니다.

## 라이선스

MIT. [`LICENSE`](LICENSE)를 보세요. 코드는 Pi에 내장된 MCP 확장에서 가져왔으며, 그 확장도 MIT License입니다.
