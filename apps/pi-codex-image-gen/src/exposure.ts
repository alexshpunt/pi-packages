import type {
    BeforeAgentStartEvent,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { IMAGE_AUTH_PROVIDER } from "./auth.js";
import { IMAGE_GEN_TOOL_NAME } from "./tool.js";

/** Session entry type recording that this extension hid or re-enabled `image_gen`. */
export const EXPOSURE_ENTRY_TYPE = "image_gen.exposure";
/** Name of the bundled skill that is listed only while the tool is exposed (FDD §9.10). */
export const IMAGEGEN_SKILL_NAME = "imagegen";

export interface ExposureRecord {
    hiddenByExtension: boolean;
    at: string;
}

/** In-memory fallback for the branch record (used only when the branch has no record). */
export interface ExposureState {
    hiddenByExtension: boolean | undefined;
}

export function createExposureState(): ExposureState {
    return { hiddenByExtension: undefined };
}

type ExposureContext = Pick<
    ExtensionContext,
    "modelRegistry" | "sessionManager"
>;

/** FDD §9.9 predicate: Pi's ChatGPT subscription login is configured, without a network call. */
export function isImageAuthConfigured(
    ctx: Pick<ExtensionContext, "modelRegistry">,
): boolean {
    return (
        ctx.modelRegistry.getProviderAuthStatus(IMAGE_AUTH_PROVIDER)
            .configured === true
    );
}

/** Latest `image_gen.exposure` record on the current branch, if any. */
export function latestBranchRecord(
    ctx: Pick<ExtensionContext, "sessionManager">,
): boolean | undefined {
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        if (
            entry?.type !== "custom" ||
            entry.customType !== EXPOSURE_ENTRY_TYPE
        ) {
            continue;
        }
        const data = entry.data as Partial<ExposureRecord> | undefined;
        if (typeof data?.hiddenByExtension === "boolean") {
            return data.hiddenByExtension;
        }
    }
    return undefined;
}

function record(
    pi: Pick<ExtensionAPI, "appendEntry">,
    state: ExposureState,
    hiddenByExtension: boolean,
): void {
    state.hiddenByExtension = hiddenByExtension;
    const entry: ExposureRecord = {
        hiddenByExtension,
        at: new Date().toISOString(),
    };
    pi.appendEntry(EXPOSURE_ENTRY_TYPE, entry);
}

/**
 * Applies the FDD §9.9 decision table and returns whether `image_gen` is active afterwards.
 * Only `image_gen` is ever added or removed; other tools keep their order and state.
 */
export function applyExposureDecision(
    pi: Pick<
        ExtensionAPI,
        "getAllTools" | "getActiveTools" | "setActiveTools" | "appendEntry"
    >,
    ctx: ExposureContext,
    state: ExposureState,
): boolean {
    const active = pi.getActiveTools();
    const isActive = active.includes(IMAGE_GEN_TOOL_NAME);
    const isRegistered = pi
        .getAllTools()
        .some((tool) => tool.name === IMAGE_GEN_TOOL_NAME);
    if (!isRegistered) {
        return isActive;
    }
    const configured = isImageAuthConfigured(ctx);
    if (isActive && configured && latestBranchRecord(ctx) === true) {
        // Pi can restore/re-activate a tool on resume, reload, or tree navigation. We no
        // longer own that active state; clear ownership before a later user disable.
        record(pi, state, false);
    }
    if (isActive && !configured) {
        pi.setActiveTools(
            active.filter((name) => name !== IMAGE_GEN_TOOL_NAME),
        );
        record(pi, state, true);
        return false;
    }
    if (!isActive && configured) {
        const hiddenByExtension =
            latestBranchRecord(ctx) ?? state.hiddenByExtension;
        if (hiddenByExtension === true) {
            pi.setActiveTools([...active, IMAGE_GEN_TOOL_NAME]);
            record(pi, state, false);
            return true;
        }
    }
    return isActive;
}

/** Removes the bundled skill from this prompt's skill list (never adds skills). */
export function hideImagegenSkill(event: BeforeAgentStartEvent): void {
    event.systemPromptOptions.skills = event.systemPromptOptions.skills.filter(
        (skill) => skill.name !== IMAGEGEN_SKILL_NAME,
    );
}
