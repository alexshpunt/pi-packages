import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBridgeRuntime } from "./app/runtime.js";
import { PiBridge } from "./adapters/pi/registration.js";

const runtime = createBridgeRuntime();
const bridge = runtime.runSync(PiBridge);

export default function (pi: ExtensionAPI): void {
	bridge.register(pi);
}
