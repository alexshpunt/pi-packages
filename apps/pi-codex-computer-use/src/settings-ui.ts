import {
    DynamicBorder,
    getSettingsListTheme,
    type KeybindingsManager,
    type Theme,
} from "@earendil-works/pi-coding-agent";
import {
    type Component,
    type SettingItem,
    SettingsList,
    Text,
} from "@earendil-works/pi-tui";
import type { FeatureKey, SettingsLoadResult } from "./settings.js";

const FEATURES: { id: FeatureKey; label: string; description: string }[] = [
    {
        id: "computerUse",
        label: "Computer Use",
        description:
            "Control native apps through Codex's Computer Use runtime.",
    },
    {
        id: "browserUse",
        label: "Browser Use",
        description: "Control Chrome through the ChatGPT extension.",
    },
];

export interface SettingsPanelOptions {
    getSettings(): SettingsLoadResult;
    setFeature(key: FeatureKey, isEnabled: boolean): Promise<void>;
    theme: Theme;
    keybindings: KeybindingsManager;
    requestRender(): void;
    onClose(): void;
}

/** Two feature switches in one native pi list; saving keeps the view and selection open. */
export class ComputerUseSettingsPanel implements Component {
    private readonly list: SettingsList;
    private readonly border: DynamicBorder;
    private isBusy = false;
    private isDisposed = false;
    private shouldCloseAfterSave = false;
    private feedback: { text: string; isError: boolean } | undefined;

    constructor(private readonly options: SettingsPanelOptions) {
        this.border = new DynamicBorder((text) =>
            options.theme.fg("accent", text),
        );
        const settings = options.getSettings();
        const items: SettingItem[] = FEATURES.map((feature) => ({
            ...feature,
            currentValue: settings.state[feature.id] ? "on" : "off",
            ...(settings.source === "invalid" ? {} : { values: ["on", "off"] }),
        }));
        this.list = new SettingsList(
            items,
            items.length,
            getSettingsListTheme(),
            (id, value) => {
                if (this.isBusy || this.isDisposed) return;
                if (id !== "computerUse" && id !== "browserUse") return;
                // Do not display the optimistic SettingsList value as saved before persistence succeeds.
                this.syncValues();
                void this.setFeature(id, value === "on");
            },
            () => this.close(),
        );
    }

    private syncValues(): void {
        const { state } = this.options.getSettings();
        for (const feature of FEATURES)
            this.list.updateValue(feature.id, state[feature.id] ? "on" : "off");
    }

    private async setFeature(
        key: FeatureKey,
        isEnabled: boolean,
    ): Promise<void> {
        this.isBusy = true;
        this.feedback = { text: "Saving…", isError: false };
        this.options.requestRender();
        try {
            await this.options.setFeature(key, isEnabled);
            this.feedback = { text: "Saved.", isError: false };
        } catch (error) {
            this.feedback = {
                text: error instanceof Error ? error.message : String(error),
                isError: true,
            };
        } finally {
            this.isBusy = false;
            if (!this.isDisposed) {
                this.syncValues();
                if (this.shouldCloseAfterSave) this.close();
                else this.options.requestRender();
            }
        }
    }

    private close(): void {
        if (this.isDisposed) return;
        if (this.isBusy) {
            this.shouldCloseAfterSave = true;
            return;
        }
        this.isDisposed = true;
        this.options.onClose();
    }

    handleInput(data: string): void {
        if (this.isDisposed) return;
        if (this.options.keybindings.matches(data, "tui.select.cancel")) {
            this.close();
            return;
        }
        if (this.isBusy) return;
        this.list.handleInput(data);
        this.options.requestRender();
    }

    render(width: number): string[] {
        const { theme } = this.options;
        const lines = [
            ...this.border.render(width),
            ...new Text(
                theme.fg("accent", theme.bold("Computer Use settings")),
                1,
                0,
            ).render(width),
            "",
            ...this.list.render(width),
        ];
        const { error } = this.options.getSettings();
        if (error)
            lines.push(
                "",
                ...new Text(
                    theme.fg("error", `Settings error: ${error}`),
                    1,
                    0,
                ).render(width),
            );
        if (this.feedback)
            lines.push(
                "",
                ...new Text(
                    theme.fg(
                        this.feedback.isError ? "error" : "muted",
                        this.feedback.text,
                    ),
                    1,
                    0,
                ).render(width),
            );
        lines.push(
            "",
            ...new Text(
                theme.fg(
                    "dim",
                    "Changes save immediately. Esc closes this view.",
                ),
                1,
                0,
            ).render(width),
            ...this.border.render(width),
        );
        return lines;
    }

    invalidate(): void {
        this.border.invalidate();
        this.list.invalidate();
    }

    dispose(): void {
        this.isDisposed = true;
    }
}
