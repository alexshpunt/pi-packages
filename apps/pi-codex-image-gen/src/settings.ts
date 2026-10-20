import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { IMAGE_MODEL, type ImageModel, isImageModel } from "./arguments.js";

/** Stores the image model separately from Pi's chat model settings. */
export class ImageGenSettingsStore {
    constructor(
        readonly path = join(getAgentDir(), "codex-image-gen", "settings.json"),
    ) {}

    private async read(): Promise<Record<string, unknown>> {
        let raw: string;
        try {
            raw = await readFile(this.path, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
            throw error;
        }
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value))
            throw new Error("이미지 생성 설정은 JSON 객체여야 합니다.");
        const settings = value as Record<string, unknown>;
        if (settings.model !== undefined && !isImageModel(settings.model))
            throw new Error(
                "이미지 생성 model은 gpt-image-2.5 또는 gpt-image-2여야 합니다.",
            );
        return settings;
    }

    async load(): Promise<ImageModel> {
        const settings = await this.read();
        return isImageModel(settings.model) ? settings.model : IMAGE_MODEL;
    }

    /** Preserves unrelated keys and atomically replaces the saved model. */
    async save(model: ImageModel): Promise<void> {
        if (!isImageModel(model))
            throw new Error("지원하지 않는 이미지 생성 모델입니다.");
        const settings = { ...(await this.read()), model };
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            await writeFile(
                temporary,
                `${JSON.stringify(settings, null, 2)}\n`,
                {
                    flag: "wx",
                    mode: 0o600,
                },
            );
            await rename(temporary, this.path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
