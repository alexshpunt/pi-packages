import {
    type ExtensionAPI,
    type ExtensionCommandContext,
    getSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    type Focusable,
    fuzzyFilter,
    Input,
    Key,
    matchesKey,
    type SelectItem,
    SelectList,
    Spacer,
    Text,
} from "@earendil-works/pi-tui";
import type { ApprovalSettingsStore } from "./approval-settings.js";
import { redact } from "./audit.js";
import { canonicalJson, GuardError } from "./contracts.js";
import { type GuardSettings, validateSettings } from "./policy/index.js";
import { reviewOnlyModels } from "./review/models.js";
import type { GuardController } from "./tools/controller.js";

type ReviewModel = GuardSettings["reviewModel"];
type ApprovalMode =
    | GuardSettings["approvalsReviewer"]
    | "full_access"
    | "disabled";
const CURRENT_MODEL = "current";
const CACHE_EXPIRY = "cache_expiry";
const modeNames = {
    auto_review: "Approve for me",
    user: "Ask for approval",
    full_access: "Full Access",
    disabled: "Auto Review Off",
} as const;
// Match the public Codex permission picker: https://learn.chatgpt.com/docs/security-administration
const approvalModes: SelectItem[] = [
    {
        value: "auto_review",
        label: modeNames.auto_review,
        description: "Only ask for actions detected as potentially unsafe",
    },
    {
        value: "user",
        label: modeNames.user,
        description: "Always ask to edit external files and use the internet",
    },
    // Codex TUI permission_preset_description("full-access"), naming Pi instead of Codex.
    {
        value: "full_access",
        label: modeNames.full_access,
        description:
            "Use with caution: Pi can edit files outside this workspace and access the internet without approval",
    },
    {
        value: "disabled",
        label: modeNames.disabled,
        description:
            "Turn off all approval and policy checks; use Pi's original tool execution. Saved across sessions.",
    },
];
// Codex TUI open_full_access_confirmation(), naming Pi instead of Codex.
const FULL_ACCESS_CONFIRMATION =
    "Enable full access?\nWhen Pi runs with full access, it can edit any file on your computer and run commands with network, without your approval. Exercise caution when enabling full access. This significantly increases the risk of data loss, leaks, or unexpected behavior.";
const fullAccessChoices = [
    "Yes, continue anyway — Apply full access for this session",
    "Cancel — Go back without enabling full access",
];

function approvalMenuItems(cacheTtlHours: number): SelectItem[] {
    return [
        ...approvalModes,
        {
            value: CACHE_EXPIRY,
            label: "Review cache expiry",
            description: `${cacheTtlHours} hours — Reuse approved reads across Pi sessions`,
        },
    ];
}

class ApprovalModePicker extends Container {
    private readonly list: SelectList;
    constructor(
        current: ApprovalMode,
        cacheTtlHours: number,
        finish: (value: string | undefined) => void,
    ) {
        super();
        this.addChild(
            new Text(`Approval mode — Current: ${modeNames[current]}`, 0, 0),
        );
        this.addChild(new Spacer(1));
        const items = approvalMenuItems(cacheTtlHours);
        this.list = new SelectList(items, items.length, getSelectListTheme(), {
            maxPrimaryColumnWidth: 22,
        });
        this.list.setSelectedIndex(
            items.findIndex((item) => item.value === current),
        );
        this.list.onSelect = (item) => finish(item.value);
        this.list.onCancel = () => finish(undefined);
        this.addChild(this.list);
        this.addChild(new Spacer(1));
        const description = new Text(
            this.list.getSelectedItem()?.description ?? "",
            0,
            0,
        );
        this.list.onSelectionChange = (item) =>
            description.setText(item.description ?? "");
        this.addChild(description);
        this.addChild(new Spacer(1));
        this.addChild(new Text("↑↓ Select · Enter Apply · Esc Cancel", 0, 0));
    }
    handleInput(data: string): void {
        this.list.handleInput(data);
    }
}

async function chooseCacheTtlHours(
    context: ExtensionCommandContext,
    currentHours: number,
): Promise<number | undefined> {
    const choices = Array.from(
        { length: 12 },
        (_, i) =>
            `${i + 1} ${i === 0 ? "hour" : "hours"}${i + 1 === currentHours ? " — Current" : ""}`,
    );
    const selected = await context.ui.select(
        `Review cache expiry — Current: ${currentHours} hours`,
        choices,
    );
    const index = choices.indexOf(selected ?? "");
    return index < 0 ? undefined : index + 1;
}

const modelIdentity = (model: { provider: string; id: string }) =>
    canonicalJson({ provider: model.provider, id: model.id });

function scopedReviewModels(
    context: ExtensionCommandContext,
    available: ReturnType<
        ExtensionCommandContext["modelRegistry"]["getAvailable"]
    >,
) {
    const scoped = context.scopedModels ?? [];
    if (!scoped.length) return available;
    const byIdentity = new Map(
        available.map((model) => [modelIdentity(model), model]),
    );
    const seen = new Set<string>();
    return scoped.flatMap(({ model }) => {
        const identity = modelIdentity(model),
            registered = byIdentity.get(identity);
        if (!registered || seen.has(identity)) return [];
        seen.add(identity);
        return [registered];
    });
}

// Review-only models bypass /scoped-models because Pi's /model never lists them.
function availableReviewModels(context: ExtensionCommandContext) {
    const available = context.modelRegistry.getAvailable();
    const listed = scopedReviewModels(context, available);
    const listedIdentities = new Set(listed.map(modelIdentity));
    return [
        ...listed,
        ...reviewOnlyModels(available).filter(
            (model) => !listedIdentities.has(modelIdentity(model)),
        ),
    ];
}

class ApprovalModelPicker extends Container implements Focusable {
    private readonly input = new Input();
    private list!: SelectList;
    private readonly results = new Container();
    private filtered: SelectItem[];
    get focused(): boolean {
        return this.input.focused;
    }
    set focused(value: boolean) {
        this.input.focused = value;
    }
    constructor(
        private readonly items: SelectItem[],
        selected: string,
        private readonly finish: (value: string | undefined) => void,
        search: string,
    ) {
        super();
        this.addChild(new Text("Approval review model", 0, 0));
        this.addChild(new Spacer(1));
        this.addChild(this.input);
        this.addChild(new Spacer(1));
        this.addChild(this.results);
        this.addChild(
            new Text("Search · ↑↓ Select · Enter Apply · Esc Cancel", 0, 0),
        );
        this.filtered = items;
        this.input.setValue(search);
        this.filter(search);
        const index = this.filtered.findIndex(
            (item) => item.value === selected,
        );
        if (index >= 0) this.list.setSelectedIndex(index);
    }
    private filter(query: string): void {
        this.filtered = query
            ? fuzzyFilter(
                  this.items,
                  query,
                  (item) => `${item.label} ${item.description ?? ""}`,
              )
            : this.items;
        this.list = new SelectList(this.filtered, 12, getSelectListTheme());
        this.list.onSelect = (item) => this.finish(item.value);
        this.list.onCancel = () => this.finish(undefined);
        this.results.clear();
        this.results.addChild(
            this.filtered.length
                ? this.list
                : new Text("No matching models.", 0, 0),
        );
    }
    handleInput(data: string): void {
        if (matchesKey(data, Key.escape)) this.finish(undefined);
        else if (
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.up) ||
            matchesKey(data, Key.down)
        )
            this.list.handleInput(data);
        else {
            const before = this.input.getValue();
            this.input.handleInput(data);
            if (this.input.getValue() !== before)
                this.filter(this.input.getValue());
        }
    }
}

async function chooseReviewModel(
    context: ExtensionCommandContext,
    current: ReviewModel,
    search: string,
): Promise<ReviewModel | undefined> {
    const models = availableReviewModels(context);
    const items: SelectItem[] = [
        {
            value: CURRENT_MODEL,
            label: "Use current Pi model",
            description: "Follow the model selected for the main task.",
        },
        ...models.map((model) => ({
            value: canonicalJson({ provider: model.provider, id: model.id }),
            label: model.name || model.id,
            description: `${model.provider}/${model.id}`,
        })),
    ];
    const selected = current ? canonicalJson(current) : CURRENT_MODEL;
    const result =
        context.mode === "rpc"
            ? await context.ui
                  .select(
                      "Approval review model",
                      items.map(
                          (item) => `${item.label} — ${item.description}`,
                      ),
                  )
                  .then((value) =>
                      value === undefined
                          ? undefined
                          : items[
                                items.findIndex(
                                    (item) =>
                                        `${item.label} — ${item.description}` ===
                                        value,
                                )
                            ]?.value,
                  )
            : await context.ui.custom<string | undefined>(
                  (_tui, _theme, _keys, done) =>
                      new ApprovalModelPicker(items, selected, done, search),
              );
    if (result === undefined) return undefined;
    return result === CURRENT_MODEL
        ? null
        : (JSON.parse(result) as ReviewModel);
}

async function retryDeniedAction(
    pi: ExtensionAPI,
    guard: GuardController,
    context: ExtensionCommandContext,
): Promise<void> {
    const denials = [...guard.approvals.lifecycle.recentDenials].reverse();
    if (!denials.length) {
        context.ui.notify("No recent denied actions to review again.", "info");
        return;
    }
    const choices = denials.map(
        (item) =>
            `${item.action.tool} | ${redact(canonicalJson(item.action.args))} | ${item.assessment.rationale} | ${item.id}`,
    );
    const selected = await context.ui.select(
        "Choose a denied action to review again once",
        choices,
    );
    const index = choices.indexOf(selected ?? "");
    const denial = denials[index];
    if (!denial) return;
    const retry = await guard.authorizeRetry(denial.id, context);
    if (retry.denial.action.source === "user-bash") {
        await guard.retryUserBash(retry.denial.action, context);
        context.ui.notify(
            "The selected command was reviewed again and executed.",
            "info",
        );
        return;
    }
    const instruction =
        retry.denial.action.source === "nested"
            ? "Invoke only this exact tool through codemode to preserve the original nested source."
            : "Retry only this exact tool action.";
    pi.sendUserMessage(
        `${instruction}\nTool: ${retry.denial.action.tool}\nArguments: ${canonicalJson(retry.args)}\nThe user selected denial ${retry.denial.id} for one retry. The controller holds a one-use exact-action marker; automatic review and policy still apply. Do not repeat unrelated earlier side effects.`,
        { expandPromptTemplates: false },
    );
}

export function registerApprovalCommands(
    pi: ExtensionAPI,
    guard: GuardController,
    store: ApprovalSettingsStore,
): void {
    const requireUI = (context: ExtensionCommandContext) => {
        if (!context.hasUI)
            throw new GuardError(
                "APPROVAL_UI_UNAVAILABLE",
                "Approval settings require an interactive Pi session",
            );
    };
    const apply = async (
        patch: Partial<
            Pick<
                GuardSettings,
                | "isEnabled"
                | "reviewModel"
                | "approvalsReviewer"
                | "reviewCacheTtlHours"
            >
        >,
        context: ExtensionCommandContext,
    ) => {
        await guard.updateSettings(
            (current) => validateSettings({ ...current, ...patch }),
            context.cwd,
            (settings) => store.save(settings),
        );
        context.ui.setStatus(
            "auto-review",
            guard.options.settings.isEnabled ? undefined : "Auto-review: Off",
        );
    };
    const setEnabled = async (
        isEnabled: boolean,
        context: ExtensionCommandContext,
    ) => {
        await apply({ isEnabled }, context);
        guard.setFullAccess(false);
        context.ui.notify(
            isEnabled
                ? `Auto-review: On — Approval mode: ${modeNames[guard.options.settings.approvalsReviewer]}`
                : "Auto-review: Off — Approval and policy checks are disabled.",
            "info",
        );
    };
    const configureCacheExpiry = async (context: ExtensionCommandContext) => {
        const hours = await chooseCacheTtlHours(
            context,
            guard.options.settings.reviewCacheTtlHours,
        );
        if (hours === undefined) return;
        await apply({ reviewCacheTtlHours: hours }, context);
        context.ui.notify(
            `Approval review cache expiry: ${hours} hours`,
            "info",
        );
    };
    pi.registerCommand("approve", {
        description:
            "Choose an approval mode or cache expiry; use /approve on, off, status, or retry.",
        handler: async (args, context) => {
            requireUI(context);
            await context.waitForIdle();
            const command = args.trim();
            if (command === "on" || command === "off") {
                await setEnabled(command === "on", context);
                return;
            }
            if (command === "status") {
                context.ui.notify(
                    guard.options.settings.isEnabled
                        ? `Auto-review: On — Approval mode: ${modeNames[guard.isFullAccess ? "full_access" : guard.options.settings.approvalsReviewer]}`
                        : "Auto-review: Off — Approval and policy checks are disabled.",
                    "info",
                );
                return;
            }
            if (command === "retry") {
                await retryDeniedAction(pi, guard, context);
                return;
            }
            if (command === "cache") {
                await configureCacheExpiry(context);
                return;
            }
            if (command)
                throw new GuardError(
                    "INVALID_APPROVAL_COMMAND",
                    "Use /approve to choose a mode, /approve on or off to enable or disable all checks, /approve status, /approve cache, or /approve retry.",
                );
            const current: ApprovalMode = !guard.options.settings.isEnabled
                ? "disabled"
                : guard.isFullAccess
                  ? "full_access"
                  : guard.options.settings.approvalsReviewer;
            const items = approvalMenuItems(
                guard.options.settings.reviewCacheTtlHours,
            );
            const choices = items.map(
                (item) => `${item.label} — ${item.description}`,
            );
            // Like Codex, cancelling the Full Access confirmation returns to the picker.
            for (;;) {
                const choice =
                    context.mode === "rpc"
                        ? await context.ui
                              .select(
                                  `Approval mode — Current: ${modeNames[current]}`,
                                  choices,
                              )
                              .then(
                                  (selected) =>
                                      items[choices.indexOf(selected ?? "")]
                                          ?.value,
                              )
                        : await context.ui.custom<string | undefined>(
                              (_tui, _theme, _keys, done) =>
                                  new ApprovalModePicker(
                                      current,
                                      guard.options.settings
                                          .reviewCacheTtlHours,
                                      done,
                                  ),
                          );
                if (choice === undefined) return;
                if (choice === CACHE_EXPIRY) {
                    await configureCacheExpiry(context);
                    return;
                }
                if (choice === "disabled") {
                    await setEnabled(false, context);
                    return;
                }
                if (choice === "full_access") {
                    const confirmed = await context.ui.select(
                        FULL_ACCESS_CONFIRMATION,
                        fullAccessChoices,
                    );
                    if (confirmed !== fullAccessChoices[0]) continue;
                    await apply({ isEnabled: true }, context);
                    guard.setFullAccess(true);
                    context.ui.setStatus("auto-review", undefined);
                    context.ui.notify(
                        `Approval mode: ${modeNames.full_access}`,
                        "info",
                    );
                    return;
                }
                const reviewer =
                    choice === "auto_review"
                        ? "auto_review"
                        : choice === "user"
                          ? "user"
                          : undefined;
                if (!reviewer) return;
                await apply(
                    { isEnabled: true, approvalsReviewer: reviewer },
                    context,
                );
                guard.setFullAccess(false);
                context.ui.notify(
                    `Approval mode: ${modeNames[reviewer]}`,
                    "info",
                );
                return;
            }
        },
    });
    pi.registerCommand("approve-model", {
        description:
            "Choose an approval review model from /scoped-models or Codex Auto Review.",
        handler: async (args, context) => {
            requireUI(context);
            await context.waitForIdle();
            const current = guard.options.settings;
            const model = await chooseReviewModel(
                context,
                current.reviewModel,
                args.trim(),
            );
            if (model === undefined) return;
            if (
                model &&
                !availableReviewModels(context).some(
                    (candidate) =>
                        candidate.provider === model.provider &&
                        candidate.id === model.id,
                )
            )
                throw new GuardError(
                    "MODEL_UNAVAILABLE",
                    "Selected review model is no longer available in the current model scope",
                );
            await apply({ reviewModel: model }, context);
            context.ui.notify(
                `Approval review model: ${model ? `${model.provider}/${model.id}` : "Use current Pi model"}`,
                "info",
            );
        },
    });
}
