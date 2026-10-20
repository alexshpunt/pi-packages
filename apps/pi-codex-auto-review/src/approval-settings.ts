import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson, GuardError } from "./contracts.js";
import {
    type GuardSettings,
    type GuardSettingsInput,
    validateSettings,
} from "./policy/index.js";

export class ApprovalSettingsStore {
    constructor(
        readonly path: string,
        private readonly defaults: GuardSettingsInput = {},
        private readonly isRequired = false,
    ) {}
    async load(): Promise<GuardSettings> {
        try {
            const stored: unknown = JSON.parse(
                await readFile(this.path, "utf8"),
            );
            validateSettings(stored);
            return validateSettings({
                ...this.defaults,
                ...(stored as GuardSettingsInput),
            });
        } catch (error) {
            if (
                !this.isRequired &&
                (error as NodeJS.ErrnoException).code === "ENOENT"
            )
                return validateSettings(this.defaults);
            throw new GuardError(
                "INVALID_SETTINGS",
                "Approval settings could not be loaded",
                { cause: error },
            );
        }
    }
    async save(settings: GuardSettings): Promise<void> {
        validateSettings(settings);
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${canonicalJson(settings)}\n`, {
                flag: "wx",
                mode: 0o600,
            });
            await rename(temporary, this.path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}
