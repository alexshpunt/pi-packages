import { Effect, ManagedRuntime } from "effect";
import type { BridgeRuntimeOptions } from "./types.js";
import { makeBridgeLive } from "./layer.js";

/** One runtime per extension instance. Session shutdown withdraws hooks;
 * retained provider registries can still call the same instance afterward. */
export function createBridgeRuntime(options: BridgeRuntimeOptions = {}) {
	const runtime = ManagedRuntime.make(makeBridgeLive(options));
	// Build before exposing the synchronous provider entry. An async dependency
	// cannot silently defer query ownership/reentrancy registration.
	runtime.runSync(Effect.void);
	return runtime;
}
