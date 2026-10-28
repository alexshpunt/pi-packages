import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BridgeRuntimeOptions } from "./app/types.js";
import { createBridgeRuntime } from "./app/runtime.js";
import { PiBridge } from "./adapters/pi/registration.js";

export type { ClaudeChildPurpose, GetChildEnv } from "./adapters/claude/types.js";

/** Builds a separate bridge instance. Its options apply only to that instance. */
export function createClaudeBridgeExtension(options: BridgeRuntimeOptions = {}): (pi: ExtensionAPI) => void {
	const runtime = createBridgeRuntime(options);
	const bridge = runtime.runSync(PiBridge);
	return (pi) => bridge.register(pi);
}

export default createClaudeBridgeExtension();
