import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { IMAGE_MODELS, isImageModel } from "./arguments.js";
import { ImageGenSettingsStore } from "./settings.js";

function report(
    ctx: ExtensionCommandContext,
    message: string,
    type: "info" | "error" = "info",
): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
    else process.stderr.write(`${message}\n`);
}

export function registerImageGenSettingsCommand(pi: ExtensionAPI): void {
    pi.registerCommand("codex-imagen", {
        description: "이미지 생성 모델을 선택하고 저장합니다.",
        getArgumentCompletions: (prefix) => {
            const choices = IMAGE_MODELS.filter((model) =>
                model.startsWith(prefix.trim()),
            ).map((model) => ({ value: model, label: model }));
            return choices.length ? choices : null;
        },
        async handler(args, ctx) {
            try {
                await ctx.waitForIdle();
                const store = new ImageGenSettingsStore();
                const currentModel = await store.load();
                let selected: string | undefined = args.trim();
                if (!selected) {
                    if (!ctx.hasUI) {
                        report(
                            ctx,
                            `이미지 생성 모델: ${currentModel}\n설정: ${store.path}\n사용법: /codex-imagen gpt-image-2.5|gpt-image-2`,
                        );
                        return;
                    }
                    selected = await ctx.ui.select(
                        `이미지 생성 모델 (현재: ${currentModel})`,
                        [
                            currentModel,
                            ...IMAGE_MODELS.filter(
                                (model) => model !== currentModel,
                            ),
                        ],
                    );
                    if (selected === undefined) return;
                }
                if (!isImageModel(selected))
                    throw new Error(
                        "사용법: /codex-imagen [gpt-image-2.5|gpt-image-2]",
                    );
                await store.save(selected);
                report(ctx, `이미지 생성 모델: ${selected}`);
            } catch (error) {
                report(
                    ctx,
                    `이미지 생성 설정을 변경하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            }
        },
    });
}
