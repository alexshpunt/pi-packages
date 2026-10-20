import { input, select } from "@inquirer/prompts";
import { fetchModelIds } from "../../src/models/api.ts";
import { OLLAMA_BASE } from "../../src/models/base.ts";
import { runChat } from "./chat.ts";
import { runDiagnostic } from "./diagnostics.ts";
import { showModelMetadata } from "./models.ts";
import { DIAGNOSTICS, MENU_CHOICES } from "./registry.ts";
import { packageFeature } from "./verify.ts";

export interface CliDependencies {
  select: (
    options: { message: string; choices: { name: string; value: string }[]; loop: boolean; pageSize?: number },
    context: { signal: AbortSignal },
  ) => Promise<string>;
  input: (
    options: { message: string; validate: (value: string) => boolean | string },
    context: { signal: AbortSignal },
  ) => Promise<string>;
  fetchModelIds: typeof fetchModelIds;
  runChat: typeof runChat;
  isTTY: boolean;
  runDiagnostic?: (id: string, signal: AbortSignal) => Promise<void>;
  showMetadata?: typeof showModelMetadata;
}
export async function runCLI(
  args = process.argv.slice(2),
  dependencies: CliDependencies = {
    select,
    input,
    fetchModelIds,
    runChat,
    isTTY: !!process.stdin.isTTY && !!process.stdout.isTTY,
  },
): Promise<void> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(`Ollama Cloud 기능 확인 CLI

실행: pnpm --filter @buyong/pi-ollama-cloud cli

- 모델 목록: ${OLLAMA_BASE}/v1/models에서 실시간 조회
- 모델 메타데이터: 공개 API의 기능·추론 값과 값의 출처 조회
- 기능별/전체 검증: 임시 fixture와 모의 전송, 전체 검증은 실제 pnpm 배포물도 검사
- 1+1 채팅: 목록에서 선택하거나 모델 ID를 직접 입력 (실제 API 사용량 발생)
- 직접 입력: glm-5.3-flash:cloud처럼 목록에 없는 유효한 ID도 그대로 전송
- 인증: Pi의 auth.json에 저장한 Ollama Cloud 키, 없으면 OLLAMA_API_KEY
- 종료: 메뉴에서 종료 선택 또는 Ctrl+C

pnpm install을 마친 모노레포의 대화형 터미널에서 실행하세요.`);
    return;
  }
  if (args.length > 0) {
    throw new Error("지원하지 않는 인수입니다. pnpm --filter @buyong/pi-ollama-cloud cli --help를 확인하세요.");
  }
  if (!dependencies.isTTY) {
    throw new Error("대화형 터미널이 필요합니다. 터미널에서 pnpm --filter @buyong/pi-ollama-cloud cli를 실행하세요.");
  }

  const controller = new AbortController();
  let exitCode = 130;
  const interrupt = () => controller.abort();
  const terminate = () => {
    exitCode = 143;
    controller.abort();
  };
  try {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    console.log(
      "Ollama Cloud 기능 확인\n모델 목록은 공개 API에서 조회합니다. 채팅은 실제 API 사용량을 발생시킵니다.\n",
    );

    while (!controller.signal.aborted) {
      try {
        const action = await dependencies.select(
          {
            message: "확인할 기능을 선택하세요.",
            choices: MENU_CHOICES,
            loop: false,
          },
          { signal: controller.signal },
        );
        if (action === "exit") return;
        if (action === "metadata") {
          await (dependencies.showMetadata ?? showModelMetadata)(controller.signal);
          continue;
        }
        if (action === "diagnostics" || action === "verify") {
          const id =
            action === "verify"
              ? "all"
              : await dependencies.select(
                  {
                    message: "오프라인 검증을 선택하세요.",
                    choices: [
                      ...DIAGNOSTICS.map((item) => ({ name: item.name, value: item.id })),
                      { name: "이전 메뉴", value: "" },
                    ],
                    loop: false,
                    pageSize: 12,
                  },
                  { signal: controller.signal },
                );
          if (!id) continue;
          if (dependencies.runDiagnostic) await dependencies.runDiagnostic(id, controller.signal);
          else {
            const feature = id === "all" ? packageFeature : DIAGNOSTICS.find((item) => item.id === id)?.feature();
            if (!feature) throw new Error("알 수 없는 기능입니다.");
            await runDiagnostic(feature, controller.signal);
          }
          continue;
        }
        if (action === "manual") {
          const modelId = await dependencies.input(
            {
              message: "모델 ID를 입력하세요 (예: glm-5.3-flash:cloud).",
              validate: (value) => value.trim().length > 0 || "모델 ID를 입력하세요.",
            },
            { signal: controller.signal },
          );
          await dependencies.runChat(modelId.trim(), controller.signal);
          continue;
        }

        console.log(`\n모델 목록 조회 중: ${OLLAMA_BASE}/v1/models`);
        const modelIds = [...new Set(await dependencies.fetchModelIds(controller.signal))].sort();
        if (modelIds.length === 0) {
          throw new Error("Ollama가 빈 모델 목록을 반환했습니다. 잠시 후 다시 조회하세요.");
        }
        if (action === "models") {
          console.log(`${modelIds.length}개 모델\n${modelIds.map((id, index) => `${index + 1}. ${id}`).join("\n")}\n`);
          continue;
        }

        const modelId = await dependencies.select(
          {
            message: "1+1을 보낼 모델을 선택하세요.",
            choices: [...modelIds.map((id) => ({ name: id, value: id })), { name: "이전 메뉴", value: "" }],
            pageSize: 12,
            loop: false,
          },
          { signal: controller.signal },
        );
        if (modelId) await dependencies.runChat(modelId, controller.signal);
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof Error && ["ExitPromptError", "AbortPromptError"].includes(error.name))
        ) {
          console.log("\n종료합니다.");
          process.exitCode = exitCode;
          return;
        }
        console.error(`\n기능 확인 실패: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    process.exitCode = exitCode;
  } finally {
    controller.abort();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
