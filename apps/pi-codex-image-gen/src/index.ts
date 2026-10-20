import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { registerImageGenSettingsCommand } from "./commands.js";
import {
    applyExposureDecision,
    createExposureState,
    hideImagegenSkill,
    latestBranchRecord,
} from "./exposure.js";
import { imageGenTool } from "./tool.js";

export type {
    ImageBackground,
    ImageGenArguments,
    ImageModel,
    ImageRequestPlan,
} from "./arguments.js";
export { parseImageGenArguments } from "./arguments.js";
export {
    MISSING_CREDENTIAL_MESSAGE,
    type OpenAiCredentials,
    resolveOpenAiCredentials,
} from "./auth.js";
export {
    applyExposureDecision,
    EXPOSURE_ENTRY_TYPE,
    type ExposureRecord,
    IMAGEGEN_SKILL_NAME,
} from "./exposure.js";
export {
    IMAGE_GEN_SCHEMA,
    IMAGE_GEN_TOOL_LABEL,
    IMAGE_GEN_TOOL_NAME,
    type ImageGenDetails,
    imageGenTool,
} from "./tool.js";

/**
 * Pi extension entry: registers the Codex-compatible `image_gen` tool and gates its exposure
 * (and the bundled `imagegen` skill) on Pi's `openai-codex` login at session start and before each
 * user prompt (FDD §9.9, §9.10).
 */
const imageGenExtension: ExtensionFactory = (pi) => {
    pi.registerTool(imageGenTool);
    registerImageGenSettingsCommand(pi);
    const state = createExposureState();
    pi.on("session_start", (_event, ctx) => {
        state.hiddenByExtension = undefined;
        applyExposureDecision(pi, ctx, state);
    });
    pi.on("session_tree", (_event, ctx) => {
        // Do not carry a different branch's in-memory ownership into this branch.
        state.hiddenByExtension = latestBranchRecord(ctx);
        applyExposureDecision(pi, ctx, state);
    });
    pi.on("before_agent_start", (event, ctx) => {
        const isExposed = applyExposureDecision(pi, ctx, state);
        if (!isExposed) {
            hideImagegenSkill(event);
        }
    });
};

export default imageGenExtension;
