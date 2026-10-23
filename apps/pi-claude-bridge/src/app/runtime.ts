import { Effect, ManagedRuntime } from "effect";
import { BridgeLive } from "./layer.js";

/** One runtime per extension module instance. Session shutdown withdraws hooks;
 * retained provider registries can still call the same instance afterward. */
export function createBridgeRuntime() {
	const runtime = ManagedRuntime.make(BridgeLive);
	// Build before exposing the synchronous provider entry. An async dependency
	// cannot silently defer query ownership/reentrancy registration.
	runtime.runSync(Effect.void);
	return runtime;
}
