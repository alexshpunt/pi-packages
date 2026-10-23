import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBridgeHarness } from "./bridge-runtime.js";

export const testBridge = createBridgeHarness();
export default function (pi: ExtensionAPI): void { testBridge.register(pi); }
