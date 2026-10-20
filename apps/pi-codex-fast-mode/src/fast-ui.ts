import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ServiceTier } from "./config.js";

const SPEEDS = ["standard", "fast", "ultrafast"] as const;
const LABELS: Record<ServiceTier, string> = {
    standard: "Standard",
    fast: "Fast",
    ultrafast: "Ultrafast",
};

export interface ModelSpeedSetting {
    model: string;
    isCurrentModel: boolean;
    availableTiers: readonly ServiceTier[];
}

interface FastSettings {
    models: readonly ModelSpeedSetting[];
    getGlobalTier: () => ServiceTier;
    getModelTier: (model: string) => ServiceTier | undefined;
    setGlobalTier: (tier: ServiceTier) => Promise<void>;
    setModelTier: (model: string, tier: ServiceTier | null) => Promise<void>;
}

/** Model overrides appear first; Enter saves a single selected speed. */
export async function showFastSettings(
    ctx: ExtensionCommandContext,
    settings: FastSettings,
): Promise<void> {
    const rows = [
        ...settings.models.map((model) => ({
            label: `${model.model}${model.isCurrentModel ? " (current)" : ""}`,
            model: model.model,
            availableTiers: model.availableTiers,
        })),
        {
            label: "Global speed",
            model: undefined,
            availableTiers: SPEEDS,
        },
    ];
    const getTier = (index: number) => {
        const row = rows[index];
        return (
            (row.model ? settings.getModelTier(row.model) : undefined) ??
            settings.getGlobalTier()
        );
    };
    const saveTier = (index: number, tier: ServiceTier | null) => {
        const row = rows[index];
        return row.model
            ? settings.setModelTier(row.model, tier)
            : settings.setGlobalTier(tier ?? settings.getGlobalTier());
    };
    if (ctx.mode !== "tui") {
        for (;;) {
            const choices = [
                ...rows.map(
                    (row, index) =>
                        `${row.label} — Speed: ${LABELS[getTier(index)]}${row.model && settings.getModelTier(row.model) === undefined ? " (global)" : ""}`,
                ),
                "Close",
            ];
            const choice = await ctx.ui.select("Codex Fast", choices);
            const index = choices.indexOf(choice ?? "");
            const row = rows[index];
            if (!row) return;
            const speeds = row.availableTiers.map((tier) => LABELS[tier]);
            if (row.model)
                speeds.push(`Use global (${LABELS[settings.getGlobalTier()]})`);
            const speed = await ctx.ui.select(`${row.label} · Speed`, speeds);
            const speedIndex = speeds.indexOf(speed ?? "");
            if (speedIndex < 0) continue;
            try {
                await saveTier(index, row.availableTiers[speedIndex] ?? null);
            } catch (error) {
                ctx.ui.notify(
                    `Change failed: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            }
        }
    }
    return ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        let selectedRowIndex = 0;
        const initialTier = getTier(selectedRowIndex);
        let focusedTier = rows[0].availableTiers.includes(initialTier)
            ? initialTier
            : rows[0].availableTiers[0];
        let firstVisibleModelIndex = 0;
        let isBusy = false;
        let isClosed = false;
        let shouldCloseAfterSave = false;
        let errorMessage: string | undefined;
        const close = () => {
            if (isClosed) return;
            if (isBusy) {
                shouldCloseAfterSave = true;
                return;
            }
            isClosed = true;
            done();
        };
        const save = async (tier: ServiceTier | null) => {
            isBusy = true;
            errorMessage = undefined;
            tui.requestRender();
            try {
                await saveTier(selectedRowIndex, tier);
                const currentTier = getTier(selectedRowIndex);
                focusedTier = rows[selectedRowIndex].availableTiers.includes(
                    currentTier,
                )
                    ? currentTier
                    : rows[selectedRowIndex].availableTiers[0];
            } catch (error) {
                errorMessage =
                    error instanceof Error ? error.message : String(error);
            } finally {
                isBusy = false;
                if (!isClosed) {
                    if (shouldCloseAfterSave) close();
                    else tui.requestRender();
                }
            }
        };
        return {
            render: (width) => {
                const contentWidth = Math.max(1, width - 2);
                const modelCount = settings.models.length;
                const visibleModelCount = Math.max(
                    1,
                    Math.floor((tui.terminal.rows - 12) / 3),
                );
                firstVisibleModelIndex = Math.min(
                    firstVisibleModelIndex,
                    Math.max(0, modelCount - visibleModelCount),
                );
                if (selectedRowIndex < modelCount) {
                    firstVisibleModelIndex = Math.min(
                        firstVisibleModelIndex,
                        selectedRowIndex,
                    );
                    firstVisibleModelIndex = Math.max(
                        firstVisibleModelIndex,
                        selectedRowIndex - visibleModelCount + 1,
                    );
                }
                const lastVisibleModelIndex = Math.min(
                    modelCount,
                    firstVisibleModelIndex + visibleModelCount,
                );
                const renderRow = (index: number): string[] => {
                    const row = rows[index];
                    const isFocused = index === selectedRowIndex;
                    const currentTier = getTier(index);
                    const isInherited =
                        !!row.model &&
                        settings.getModelTier(row.model) === undefined;
                    const options = SPEEDS.map((tier) => {
                        const label =
                            currentTier === tier
                                ? `[${LABELS[tier]}]`
                                : LABELS[tier];
                        if (!row.availableTiers.includes(tier))
                            return theme.fg("dim", `${label} ×`);
                        return isFocused && focusedTier === tier
                            ? theme.fg("accent", theme.bold(`›${label}‹`))
                            : theme.fg(
                                  currentTier === tier ? "text" : "muted",
                                  label,
                              );
                    }).join("  ");
                    const speed =
                        contentWidth < 50
                            ? `${LABELS[currentTier]}${isFocused && focusedTier !== currentTier ? ` → ${LABELS[focusedTier]}` : ""}`
                            : options;
                    return [
                        `${isFocused ? "›" : " "} ${theme.bold(row.label)}${isInherited ? theme.fg("muted", " · global") : ""}`,
                        `  Speed: ${speed}`,
                        "",
                    ];
                };
                return new Text(
                    [
                        theme.bold("Codex Fast · model speed > global speed"),
                        theme.fg(
                            "muted",
                            modelCount === 0
                                ? "No models with speed controls available."
                                : modelCount > visibleModelCount
                                  ? `Models ${firstVisibleModelIndex + 1}–${lastVisibleModelIndex} / ${modelCount}`
                                  : "Models",
                        ),
                        ...rows
                            .slice(
                                firstVisibleModelIndex,
                                lastVisibleModelIndex,
                            )
                            .flatMap((_, index) =>
                                renderRow(firstVisibleModelIndex + index),
                            ),
                        ...renderRow(modelCount),
                        theme.fg(
                            "dim",
                            "↑/↓ model · ←/→ or Tab speed · Enter save",
                        ),
                        theme.fg(
                            "dim",
                            "R use global · Esc close · × unavailable",
                        ),
                        ...(isBusy ? [theme.fg("muted", "Applying…")] : []),
                        ...(errorMessage
                            ? [
                                  theme.fg(
                                      "error",
                                      `Change failed: ${errorMessage}`,
                                  ),
                              ]
                            : []),
                    ]
                        .map((line) => truncateToWidth(line, contentWidth))
                        .join("\n"),
                    1,
                    1,
                ).render(width);
            },
            handleInput: (data) => {
                if (isClosed) return;
                if (keybindings.matches(data, "tui.select.cancel")) {
                    close();
                } else if (isBusy) {
                    return;
                } else if (
                    matchesKey(data, Key.up) ||
                    matchesKey(data, Key.down)
                ) {
                    const direction = matchesKey(data, Key.up) ? -1 : 1;
                    selectedRowIndex =
                        (selectedRowIndex + direction + rows.length) %
                        rows.length;
                    const row = rows[selectedRowIndex];
                    const tier = getTier(selectedRowIndex);
                    focusedTier = row.availableTiers.includes(tier)
                        ? tier
                        : row.availableTiers[0];
                    errorMessage = undefined;
                    tui.requestRender();
                } else if (
                    matchesKey(data, Key.left) ||
                    matchesKey(data, Key.right) ||
                    matchesKey(data, Key.tab) ||
                    matchesKey(data, Key.shift("tab"))
                ) {
                    const tiers = rows[selectedRowIndex].availableTiers;
                    const direction =
                        matchesKey(data, Key.left) ||
                        matchesKey(data, Key.shift("tab"))
                            ? -1
                            : 1;
                    focusedTier =
                        tiers[
                            (tiers.indexOf(focusedTier) +
                                direction +
                                tiers.length) %
                                tiers.length
                        ];
                    errorMessage = undefined;
                    tui.requestRender();
                } else if (matchesKey(data, Key.enter)) {
                    void save(focusedTier);
                } else if (
                    (matchesKey(data, "r") ||
                        matchesKey(data, Key.shift("r"))) &&
                    rows[selectedRowIndex].model
                ) {
                    void save(null);
                }
            },
            invalidate: () => {},
            dispose: () => {
                isClosed = true;
            },
        };
    });
}
